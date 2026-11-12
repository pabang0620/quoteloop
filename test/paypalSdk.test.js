import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSdkOps, buildSdkClient, SANDBOX_BASE, translate, PaypalCallError } from '../shared/paypalSdk.js'
import { createPaypal } from '../shared/paypal.js'
import { openDb } from '../shared/docdb.js'
import { HttpError } from '../shared/http.js'
import { claimWrite, runClaimed } from '../shared/claims.js'
import { startVaultSetup, completeVaultSetup, assertKnownVault } from '../supplier/vault.js'
import { runDueRefunds, scheduleJudgeRefund, healthCheck } from '../supplier/refunds.js'
import { startWorld } from './helpers.js'
import { fromCents } from '../shared/money.js'
import { MSG } from '../shared/protocol.js'
import { signJws } from '../shared/jws.js'

// ---- A fake fetch for ClientOptions.fetch (typescript-testing) ----
const json = (status, body) => new Response(JSON.stringify(body), { status })
const TOKEN = { access_token: 'T', token_type: 'Bearer', expires_in: 3600 }

function stubFetch(responder) {
  const calls = []
  const fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = request.body === null ? undefined : await request.clone().text()
    const call = { url: new URL(request.url), method: request.method, headers: request.headers, body, parsed: body && body.startsWith('{') ? JSON.parse(body) : undefined }
    calls.push(call)
    if (call.url.pathname === '/v1/oauth2/token') return json(200, TOKEN)
    return responder(call, request)
  }
  const writes = () => calls.filter((c) => c.url.pathname !== '/v1/oauth2/token')
  return { fetch, calls, writes }
}

const WIRE = {
  setup: { id: 'SETUP-1', status: 'PAYER_ACTION_REQUIRED', links: [{ href: 'https://pay.example/approve', rel: 'approve', method: 'GET' }] },
  token: { id: 'VAULT-1', payment_source: { paypal: { email_address: 'judge@example.com' } } },
  order: { id: 'ORD-1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '245.86' } }] } }] },
  created: { id: 'ORD-2', status: 'PAYER_ACTION_REQUIRED', links: [{ href: 'https://pay.example/payer', rel: 'payer-action', method: 'GET' }] },
  refund: { id: 'REF-1', status: 'COMPLETED' },
}
const noop = () => {}
const sdk = (stub, extra = {}) => createSdkOps({ label: 't', clientId: 'id', clientSecret: 'secret', fetch: stub.fetch, retry: { maxRetries: 0 }, log: noop, ...extra }).ops
const failConnection = () => { throw new Error('socket hang up') }

// Headers the SDK itself owns; everything else on a request must be a header this code set on purpose.
const SDK_HEADERS = /^(authorization|content-type|idempotency-key|user-agent|x-apimatic-.+)$/
const ownHeaders = (call) => [...call.headers.keys()].filter((k) => !SDK_HEADERS.test(k)).sort()

test('host binding: the client refuses any host except the sandbox or a local mock, and any missing credential', () => {
  assert.ok(buildSdkClient({ clientId: 'a', clientSecret: 'b' }))
  assert.ok(buildSdkClient({ clientId: 'a', clientSecret: 'b', baseUrl: 'http://127.0.0.1:4103' }))
  assert.throws(() => buildSdkClient({ clientId: 'a', clientSecret: 'b', baseUrl: 'https://api-m.paypal.com' }), /refuses host/)
  assert.throws(() => buildSdkClient({ clientId: 'a', clientSecret: '' }), /client secret/)
  assert.equal(SANDBOX_BASE, 'https://api-m.sandbox.paypal.com')
})

test('requests: every SDK write carries the claim request id and no field the code did not set', async () => {
  const stub = stubFetch((call) => {
    const p = call.url.pathname
    if (p === '/v3/vault/setup-tokens') return json(201, WIRE.setup)
    if (p === '/v3/vault/payment-tokens') return json(201, WIRE.token)
    if (p.endsWith('/capture')) return json(201, WIRE.order)
    if (p === '/v2/checkout/orders') return json(201, call.parsed.payment_source.paypal.vault_id ? WIRE.order : WIRE.created)
    if (p.endsWith('/refund')) return json(201, WIRE.refund)
    throw new Error(`unexpected ${p}`)
  })
  const ops = sdk(stub, { vault: { storedCredential: true, usagePattern: 'UNSCHEDULED_POSTPAID' } })
  await ops.createSetupToken({ returnUrl: 'https://s/return', cancelUrl: 'https://s/cancel', requestId: 'rq-setup' })
  await ops.createPaymentToken('SETUP-1', { requestId: 'rq-token' })
  await ops.chargeVault({ vaultId: 'VAULT-1', amountCents: 24586, invoiceId: 'INV-0042', customId: 'hash1', requestId: 'rq-charge' })
  await ops.createHumanOrder({ amountCents: 25088, invoiceId: 'INV-0043', returnUrl: 'https://s/r', cancelUrl: 'https://s/c', requestId: 'rq-human' })
  await ops.captureOrder('ORD-2', { requestId: 'rq-capture' })
  await ops.refundCapture('CAP-1', 24586, 'INV-0042', { requestId: 'rq-refund' })
  const [setup, token, charge, human, capture, refund] = stub.writes()

  assert.deepEqual(ownHeaders(setup), ['paypal-request-id'])
  assert.equal(setup.headers.get('paypal-request-id'), 'rq-setup')
  assert.deepEqual(setup.parsed, { payment_source: { paypal: {
    usage_type: 'MERCHANT', customer_type: 'CONSUMER', usage_pattern: 'UNSCHEDULED_POSTPAID',
    // Members the SDK fills with its own defaults: they are sent even though this code never set them.
    permit_multiple_payment_tokens: false,
    experience_context: { return_url: 'https://s/return', cancel_url: 'https://s/cancel', shipping_preference: 'GET_FROM_FILE', user_action: 'CONTINUE' },
  } } })

  assert.deepEqual(ownHeaders(token), ['paypal-request-id'])
  assert.deepEqual(token.parsed, { payment_source: { token: { id: 'SETUP-1', type: 'SETUP_TOKEN' } } })

  assert.equal(charge.url.pathname, '/v2/checkout/orders')
  assert.deepEqual(ownHeaders(charge), ['paypal-request-id', 'prefer'])
  assert.equal(charge.headers.get('prefer'), 'return=representation')
  assert.equal(charge.headers.get('paypal-request-id'), 'rq-charge')
  assert.deepEqual(charge.parsed, {
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: '245.86' }, invoice_id: 'INV-0042', custom_id: 'hash1' }],
    payment_source: { paypal: { vault_id: 'VAULT-1', stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT' } } },
  })

  assert.deepEqual(ownHeaders(human), ['paypal-request-id', 'prefer'])
  assert.equal(human.headers.get('prefer'), 'return=minimal', 'the SDK default stays: only id and links are read')
  assert.deepEqual(human.parsed.purchase_units, [{ amount: { currency_code: 'USD', value: '250.88' }, invoice_id: 'INV-0043' }])
  const ctx = human.parsed.payment_source.paypal.experience_context
  assert.deepEqual([ctx.return_url, ctx.cancel_url, ctx.user_action, ctx.shipping_preference], ['https://s/r', 'https://s/c', 'PAY_NOW', 'NO_SHIPPING'])
  assert.equal(human.parsed.payment_source.paypal.vault_id, undefined)

  assert.equal(capture.url.pathname, '/v2/checkout/orders/ORD-2/capture')
  assert.deepEqual(ownHeaders(capture), ['paypal-request-id', 'prefer'])
  assert.equal(capture.headers.get('prefer'), 'return=representation')
  // An empty JSON body: without it the SDK sends no Content-Type and the sandbox answers 415 (VERIFY.md check 14).
  assert.equal(capture.body, '{}')
  assert.match(capture.headers.get('content-type'), /application\/json/)

  assert.equal(refund.url.pathname, '/v2/payments/captures/CAP-1/refund')
  assert.deepEqual(ownHeaders(refund), ['paypal-request-id', 'prefer'])
  assert.deepEqual(refund.parsed, { amount: { currency_code: 'USD', value: '245.86' }, invoice_id: 'INV-0042', note_to_payer: 'Judge sandbox balance restore' })
  for (const c of stub.writes()) assert.ok(c.headers.get('idempotency-key'), 'the SDK mints its own Idempotency-Key beside ours')
})

test('answers come back in the REST wire shape the callers read', async () => {
  const stub = stubFetch((call) => {
    const p = call.url.pathname
    if (p === '/v1/reporting/transactions') return json(200, { transaction_details: [{ transaction_info: { transaction_id: 'T1', transaction_amount: { currency_code: 'USD', value: '-245.86' }, custom_field: 'hash1', invoice_id: 'INV-0042', transaction_initiation_date: '2026-11-12T01:02:03+0000' } }], page: 1, total_items: 1, total_pages: 1 })
    if (p === '/v1/reporting/balances') return json(200, { balances: [{ currency: 'USD', primary: true, total_balance: { currency_code: 'USD', value: '9999.00' }, available_balance: { currency_code: 'USD', value: '9876.54' } }], account_id: 'ACC' })
    if (p === '/v2/checkout/orders/ORD-1') return json(200, WIRE.order)
    return json(201, WIRE.token)
  })
  const ops = sdk(stub)
  const token = await ops.createPaymentToken('S', { requestId: 'r' })
  assert.equal(token.payment_source.paypal.email_address, 'judge@example.com')
  const order = await ops.getOrder('ORD-1')
  assert.equal(order.purchase_units[0].payments.captures[0].amount.value, '245.86')
  const txns = await ops.listTransactions('2026-11-09T00:00:00Z', '2026-11-12T00:00:00Z')
  assert.equal(txns.transaction_details[0].transaction_info.custom_field, 'hash1')
  const q = stub.calls.find((c) => c.url.pathname === '/v1/reporting/transactions').url.searchParams
  assert.deepEqual([q.get('start_date'), q.get('end_date'), q.get('page_size')], ['2026-11-09T00:00:00Z', '2026-11-12T00:00:00Z', '500'])
  assert.equal(await ops.balance(), 987654)
})

// ---- WHEN THE API SAYS NO ----
test('API refusals: a 4xx keeps its status and PayPal reason, 401/403 and 429 and 5xx become fixed answers', async () => {
  const answers = []
  const stub = stubFetch(() => answers.shift())
  const ops = sdk(stub)
  const cases = [
    [json(422, { name: 'UNPROCESSABLE_ENTITY', message: 'x', debug_id: 'd1', details: [{ issue: 'DUPLICATE_INVOICE_ID', description: 'Duplicate Invoice ID detected.' }] }), 422, /Duplicate Invoice ID detected/, 'DUPLICATE_INVOICE_ID'],
    [json(401, { name: 'AUTHENTICATION_FAILURE', message: 'secret reason', debug_id: 'd2' }), 502, /refused our credentials/, 'paypal_credentials'],
    [json(403, { name: 'NOT_AUTHORIZED', message: 'secret reason', debug_id: 'd3' }), 502, /refused our credentials/, 'paypal_credentials'],
    [json(429, { name: 'RATE_LIMIT_REACHED', message: 'secret reason', debug_id: 'd4' }), 503, /rate limiting/, 'paypal_quota'],
    [json(500, { name: 'INTERNAL_SERVER_ERROR', message: 'secret reason', debug_id: 'd5' }), 502, /PayPal had an error/, 'paypal_error'],
  ]
  for (const [response, status, message, code] of cases) {
    answers.push(response)
    const err = await ops.getOrder('ORD-1').then(() => null, (e) => e)
    assert.ok(err instanceof HttpError, code)
    assert.equal(err.status, status, code)
    assert.match(err.message, message)
    assert.equal(err.code, code)
    assert.doesNotMatch(err.message, /secret reason|https?:\/\//, 'no SDK message and no URL reaches the caller')
  }
})

test('a refused write is a refusal, a 5xx write and a wrong-typed 2xx are unknown, never "failed"', async () => {
  let n = 0
  const stub = stubFetch(() => {
    n += 1
    if (n === 1) return json(422, { name: 'UNPROCESSABLE_ENTITY', message: 'bad', debug_id: 'd', details: [{ issue: 'PAYER_ACTION_REQUIRED', description: 'Payer must act.' }] })
    return json(500, { name: 'INTERNAL_SERVER_ERROR', message: 'oops', debug_id: 'd' })
  })
  const ops = sdk(stub)
  const refused = await ops.createPaymentToken('S', { requestId: 'r' }).catch((e) => e)
  assert.equal(refused.outcome, 'refused')
  assert.equal(refused.status, 422)
  assert.match(refused.message, /Payer must act/)
  const unknown = await ops.createPaymentToken('S', { requestId: 'r' }).catch((e) => e)
  assert.equal(unknown.outcome, 'unknown')
  assert.equal(unknown.code, 'paypal_outcome_unknown')
  assert.equal(unknown.status, 502)
  assert.match(unknown.message, /do not pay twice/)
  const unreadable = sdk(stubFetch(() => json(201, { id: 42 })))
  const wrongType = await unreadable.createPaymentToken('S', { requestId: 'r' }).catch((e) => e)
  assert.equal(wrongType.code, 'paypal_outcome_unknown')
  const truncated = sdk(stubFetch(() => json(201, {})))
  const missingId = await truncated.chargeVault({ vaultId: 'V', amountCents: 100, invoiceId: 'I', customId: 'c', requestId: 'r' }).catch((e) => e)
  assert.equal(missingId.code, 'paypal_outcome_unknown', 'a 2xx without the id we depend on is unknown')
})

test('a read that cannot reach PayPal is a plain 502, a bad credential is a config error', async () => {
  const lost = sdk(stubFetch(failConnection))
  const read = await lost.getOrder('ORD-1').catch((e) => e)
  assert.deepEqual([read.status, read.code], [502, 'paypal_unreachable'])
  const badAuth = sdk({ fetch: async () => json(401, { error: 'invalid_client' }), calls: [] })
  const auth = await badAuth.getOrder('ORD-1').catch((e) => e)
  assert.deepEqual([auth.status, auth.code, auth.outcome], [502, 'paypal_auth', 'not_sent'])
})

test('translate rethrows what is not a PayPal error (a bug or a caller abort)', () => {
  assert.throws(() => translate(new TypeError('bug'), { op: 'x', write: true }), TypeError)
  assert.ok(new PaypalCallError(502, 'm', 'c', 'unknown') instanceof HttpError)
})

// ---- UNKNOWN OUTCOMES: a lost answer is re-read with the same reference, a request that never left is not ----
const lostThen = (answer) => {
  let first = true
  return (call) => {
    if (first) { first = false; return failConnection() }
    return answer(call)
  }
}
const PATHS = {
  setup: ['/v3/vault/setup-tokens', WIRE.setup, (o) => o.createSetupToken({ returnUrl: 'https://r', cancelUrl: 'https://c', requestId: 'rq-1' })],
  token: ['/v3/vault/payment-tokens', WIRE.token, (o) => o.createPaymentToken('SETUP-1', { requestId: 'rq-1' })],
  vault: ['/v2/checkout/orders', WIRE.order, (o) => o.chargeVault({ vaultId: 'V', amountCents: 100, invoiceId: 'I', customId: 'c', requestId: 'rq-1' })],
  human: ['/v2/checkout/orders', WIRE.created, (o) => o.createHumanOrder({ amountCents: 100, invoiceId: 'I', returnUrl: 'https://r', cancelUrl: 'https://c', requestId: 'rq-1' })],
  refund: ['/v2/payments/captures/CAP-1/refund', WIRE.refund, (o) => o.refundCapture('CAP-1', 100, 'I', { requestId: 'rq-1' })],
}
for (const [name, [path, answer, run]] of Object.entries(PATHS)) {
  test(`${name}: a lost answer is settled by replaying the same PayPal-Request-Id; a refused credential is not re-read`, async () => {
    const stub = stubFetch(lostThen(() => json(201, answer)))
    const value = await run(sdk(stub))
    assert.ok(value.id, 'settled from what PayPal holds')
    const sent = stub.writes()
    assert.equal(sent.length, 2, 'the write and one re-read')
    assert.deepEqual(sent.map((c) => c.headers.get('paypal-request-id')), ['rq-1', 'rq-1'])
    assert.equal(sent[1].url.pathname, path)

    const refused = stubFetch(() => json(401, { error: 'invalid_client' }))
    const neverSent = createSdkOps({ label: 't', clientId: 'id', clientSecret: 's', retry: { maxRetries: 0 }, log: noop, fetch: async (input) => {
      const req = input
      refused.calls.push({ url: new URL(req.url) })
      return new URL(req.url).pathname === '/v1/oauth2/token' ? json(401, { error: 'invalid_client' }) : json(500, {})
    } }).ops
    const err = await run(neverSent).catch((e) => e)
    assert.equal(err.outcome, 'not_sent')
    assert.equal(refused.calls.filter((c) => c.url.pathname !== '/v1/oauth2/token').length, 0, 'no write and no re-read left the process')
  })
}

test('a write that is lost twice stays unknown (502 paypal_outcome_unknown), never failed', async () => {
  const stub = stubFetch(failConnection)
  const err = await PATHS.vault[2](sdk(stub)).catch((e) => e)
  assert.deepEqual([err.status, err.code, err.outcome], [502, 'paypal_outcome_unknown', 'unknown'])
  assert.equal(stub.writes().length, 2)
})

test('capture: a lost answer is settled by reading the order, and an order that is not COMPLETED stays unknown', async () => {
  let n = 0
  const stub = stubFetch((call) => {
    n += 1
    if (n === 1) return failConnection()
    assert.equal(call.method, 'GET')
    assert.equal(call.url.pathname, '/v2/checkout/orders/ORD-2')
    return json(200, WIRE.order)
  })
  const done = await sdk(stub).captureOrder('ORD-2', { requestId: 'rq-c' })
  assert.equal(done.purchase_units[0].payments.captures[0].id, 'CAP-1')
  assert.deepEqual(stub.writes().map((c) => c.method), ['POST', 'GET'])

  let m = 0
  const waiting = stubFetch(() => (++m === 1 ? failConnection() : json(200, { id: 'ORD-2', status: 'APPROVED' })))
  const err = await sdk(waiting).captureOrder('ORD-2', { requestId: 'rq-c' }).catch((e) => e)
  assert.equal(err.code, 'paypal_outcome_unknown')

  const never = createSdkOps({ label: 't', clientId: 'a', clientSecret: 'b', retry: { maxRetries: 0 }, log: noop, fetch: async () => json(401, { error: 'invalid_client' }) }).ops
  const refusedCred = await never.captureOrder('ORD-2', { requestId: 'rq-c' }).catch((e) => e)
  assert.equal(refusedCred.outcome, 'not_sent')
})

test('a value that will not encode never leaves the process and is not re-read', async () => {
  const stub = stubFetch(() => json(201, WIRE.order))
  const err = await sdk(stub).captureOrder(undefined, { requestId: 'r' }).catch((e) => e)
  assert.deepEqual([err.status, err.code, err.outcome], [500, 'paypal_encode', 'not_sent'])
  assert.equal(stub.writes().length, 0)
})

// ---- DUPLICATE CLAIMS: the claim row is in the store when the request leaves, and a second caller is stopped ----
const claimSnapshot = (db, key) => db.get('paypal_claims', key)

test('createSetupToken and createPaymentToken: the claim is written before the request leaves; a concurrent second call is refused', async () => {
  const db = openDb(':memory:')
  const seen = {}
  let release
  const gate = new Promise((r) => { release = r })
  const stub = stubFetch(async (call) => {
    if (call.url.pathname === '/v3/vault/setup-tokens') {
      seen.setup = claimSnapshot(db, 'setup:buyer-1')
      await gate
      return json(201, WIRE.setup)
    }
    seen.token = claimSnapshot(db, 'token:SETUP-1')
    return json(201, WIRE.token)
  })
  const paypal = { mode: 'sandbox', ...sdk(stub) }
  const config = { publicUrl: 'https://s', buyerUiUrl: 'https://b', judge: { emails: ['judge@example.com'] } }
  const first = startVaultSetup({ db, config, paypal, buyerId: 'buyer-1' })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(seen.setup.state, 'CALLING')
  await assert.rejects(() => startVaultSetup({ db, config, paypal, buyerId: 'buyer-1' }), (e) => e.code === 'claim_in_flight')
  release()
  const started = await first
  assert.equal(started.setup_id, 'SETUP-1')
  assert.equal(stub.writes().length, 1, 'the refused second call never reached PayPal')
  assert.equal(claimSnapshot(db, 'setup:buyer-1'), null, 'released once recorded')

  const vault = await completeVaultSetup({ db, config, paypal, setupId: 'SETUP-1' })
  assert.equal(seen.token.state, 'CALLING')
  assert.equal(vault.vault_id, 'VAULT-1')
  assert.equal(claimSnapshot(db, 'token:SETUP-1').state, 'DONE')
  db.put('vault_setups', 'SETUP-1', { setup_id: 'SETUP-1', buyer_id: 'buyer-1' })
  await assert.rejects(() => completeVaultSetup({ db, config, paypal, setupId: 'SETUP-1' }), (e) => e.code === 'claim_done')
  assert.equal(stub.writes().length, 2)
})

test('a claim is released when PayPal refuses, kept as UNKNOWN with its request id when the answer is lost', async () => {
  const db = openDb(':memory:')
  await assert.rejects(() => runClaimed(db, 'k1', async () => { throw new PaypalCallError(422, 'no', 'X', 'refused') }), /no/)
  assert.equal(claimSnapshot(db, 'k1'), null)
  let firstId
  await assert.rejects(() => runClaimed(db, 'k2', async (id) => { firstId = id; throw new PaypalCallError(502, 'unknown', 'paypal_outcome_unknown', 'unknown') }))
  assert.equal(claimSnapshot(db, 'k2').state, 'UNKNOWN')
  await runClaimed(db, 'k2', async (id) => assert.equal(id, firstId, 'the retry reuses the request id'))
  const stale = claimWrite(db, 'k3', { now: 0 })
  assert.equal(claimWrite(db, 'k3', { now: 10 * 60 * 1000 }).requestId, stale.requestId, 'a crashed in-flight claim is taken over with its request id')
})

test('refund: the job is claimed before the request leaves, a concurrent run skips it, and an unknown capture never reaches the SDK', async () => {
  const db = openDb(':memory:')
  const config = { judge: { autoRefundDelayMs: 0 } }
  const events = { emit: noop }
  const limits = { adjustBalance: noop }
  let seen
  let release
  const gate = new Promise((r) => { release = r })
  const stub = stubFetch(async (call) => {
    seen = db.get('refund_jobs', 'CAP-1')
    await gate
    return json(201, WIRE.refund)
  })
  const paypal = { ...sdk(stub), recordRefund: async () => ({}) }
  const run = () => runDueRefunds({ db, config, paypalFor: () => paypal, limits, events })
  db.put('charges', 'CAP-1', { capture_id: 'CAP-1', amount_cents: 24586, refunded: false })
  scheduleJudgeRefund({ db, config, charge: { capture_id: 'CAP-1', quote_id: 'Q-1', invoice_id: 'INV-1', invoice_ref: null, amount_cents: 24586, rail: 'mock' } })
  const a = run()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(seen.state, 'refunding')
  assert.ok(seen.request_id)
  assert.deepEqual(await run(), [], 'the second run finds the job already claimed')
  release()
  assert.deepEqual(await a, [{ id: 'CAP-1', ok: true }])
  assert.equal(stub.writes().length, 1)
  assert.equal(db.get('refund_jobs', 'CAP-1').state, 'done')

  const other = openDb(':memory:')
  other.put('refund_jobs', 'CAP-X', { id: 'CAP-X', capture_id: 'CAP-X', amount_cents: 100, rail: 'mock', due_at: 0, state: 'scheduled', attempts: 0 })
  const untouched = stubFetch(() => json(201, WIRE.refund))
  assert.deepEqual(await runDueRefunds({ db: other, config, paypalFor: () => sdk(untouched), limits, events }), [])
  assert.equal(untouched.writes().length, 0, 'the SDK is never called for a capture this supplier did not charge')
  assert.equal(other.get('refund_jobs', 'CAP-X').state, 'failed')
})

test('a vault id the supplier never saved is refused and the SDK is never called', async () => {
  const db = openDb(':memory:')
  db.put('vaults', 'b1', { vault_id: 'VAULT-1', active: true, rail: 'sandbox' })
  assertKnownVault(db, 'VAULT-1')
  assert.throws(() => assertKnownVault(db, 'VAULT-STRANGER'), (e) => e.code === 'unknown_vault')
  const stub = stubFetch(() => json(201, WIRE.order))
  const result = await healthCheck({ db, config: {}, paypalFor: () => sdk(stub), vault: { vault_id: 'VAULT-STRANGER', active: true, rail: 'sandbox' }, events: { emit: noop }, cosign: { hash: 'h', invoiceId: 'HEALTH-2026-11-12' } })
  assert.equal(result.ok, false)
  assert.match(result.detail, /not one this supplier stored/)
  assert.equal(stub.writes().length, 0)
  assert.equal(claimSnapshot(db, `health:${result.at.slice(0, 10)}`), null, 'no claim was left behind')
})

// ---- The SDK adapter end to end, against the local mock PayPal process (same REST paths and shapes) ----
function sdkInjection(db, spy) {
  return ({ mockBase }) => {
    const rest = createPaypal({ label: 'supplier', mockBase, mockClientId: 'mock-supplier-client', mockClientSecret: 'mock-supplier-secret', forceMock: true })
    const spyFetch = async (input) => {
      const request = input
      const url = new URL(request.url)
      const body = request.body === null ? undefined : await request.clone().text()
      spy.push({ method: request.method, path: url.pathname, requestId: request.headers.get('paypal-request-id'), prefer: request.headers.get('prefer'), body: body && body.startsWith('{') ? JSON.parse(body) : body, claims: db.list('paypal_claims'), cosigns: db.list('cosigns'), jobs: db.list('refund_jobs') })
      return fetch(request.clone ? new Request(request.url, { method: request.method, headers: request.headers, body, duplex: 'half' }) : request)
    }
    const { ops } = createSdkOps({ label: 'supplier', clientId: 'mock-supplier-client', clientSecret: 'mock-supplier-secret', baseUrl: mockBase, fetch: spyFetch, retry: { maxRetries: 0 }, log: noop })
    return { db, paypal: { ...rest, ...ops } }
  }
}

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}

test('the whole deal runs through the SDK adapter: vault, order, refund; each claim is in the store when its request leaves', async () => {
  const db = openDb(':memory:')
  const spy = []
  await world({ supplierInjected: sdkInjection(db, spy) }, async (w) => {
    const setup = spy.find((c) => c.path === '/v3/vault/setup-tokens')
    assert.equal(setup.claims.find((c) => c.key === 'setup:brightcup-cafes').state, 'CALLING')
    const token = spy.find((c) => c.path === '/v3/vault/payment-tokens')
    assert.equal(token.claims.find((c) => c.key.startsWith('token:')).state, 'CALLING')

    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    assert.equal(deal.status, 'paid')
    const charge = spy.find((c) => c.path === '/v2/checkout/orders')
    const row = charge.cosigns.find((c) => c.quote_id === deal.quote_id)
    assert.deepEqual([row.state, row.in_flight], ['CHARGING', true], 'the co-signature claim is in flight when the charge leaves')
    assert.equal(charge.requestId, row.nonce, 'the claim nonce is the PayPal-Request-Id')
    assert.equal(charge.prefer, 'return=representation')
    assert.equal(charge.body.purchase_units[0].amount.value, '245.86')
    assert.equal(charge.body.purchase_units[0].custom_id, deal.cosign_hash)
    assert.equal(w.mock.orders.size, 1)
    assert.equal(w.mock.captures.size, 1)
    assert.equal(db.get('cosigns', row.nonce).in_flight, undefined, 'recorded and no longer in flight')

    const results = await runDueRefunds({ db, config: w.supplier.ctx.config, paypalFor: w.supplier.ctx.paypalFor, limits: w.supplier.ctx.limits, events: w.supplier.ctx.events })
    assert.deepEqual(results.map((r) => r.ok), [true])
    const refund = spy.find((c) => c.path.endsWith('/refund'))
    assert.equal(refund.jobs[0].state, 'refunding')
    assert.equal(refund.requestId, refund.jobs[0].request_id)
    assert.equal(db.list('refund_jobs')[0].state, 'done')
  })
})

test('a second co-signature charge is refused while the first is in flight, and no order leaves', async () => {
  const db = openDb(':memory:')
  const spy = []
  await world({ supplierInjected: sdkInjection(db, spy) }, async (w) => {
    const deals = w.buyer.deals
    const deal = deals.startDeal({ mandateId: 'MND-A-LEAN', request: { sku: 'CUP-12-HOT', qty: 2 }, mode: 'policy', clientKey: 't' })
    await deals.sendRfq(deal, deal.request)
    await deals.counter(deal, { option_id: 'Q-0042-v1-a', pay_now: true })
    await deals.acceptQuote(deal, 'Q-0042-v2-a')
    assert.equal((await deals.verifyDeal(deal)).ok, true)
    const claims = { v: 1, payee: 'northbeam-supply', amount: fromCents(deal.accepted.option.total_cents), currency: 'USD', invoice_number: deal.draft.invoice_number, quote_id: deal.quote_id, quote_hash: deal.accepted.quote_hash, mandate_id: deal.mandate_id, nonce: 'nonce-inflight-1', exp: Math.floor(Date.now() / 1000) + 600 }
    // The first caller is mid-flight: its claim row says so.
    db.put('cosigns', claims.nonce, { nonce: claims.nonce, quote_id: deal.quote_id, state: 'CHARGING', in_flight: true })
    const send = () => w.buyer.ctx.supplier.send(MSG.COSIGN, deal.task_id, { quote_id: deal.quote_id, cosign_jws: signJws(claims, w.buyer.ctx.signer) }, 'northbeam-supply')
    await assert.rejects(send, /already running/)
    assert.equal(w.mock.orders.size, 0)
    assert.equal(spy.filter((c) => c.path === '/v2/checkout/orders').length, 0)
    // The first caller finished without an answer: unknown, not in flight. The retry reuses the nonce and lands once.
    db.put('cosigns', claims.nonce, { nonce: claims.nonce, quote_id: deal.quote_id, state: 'CHARGING', in_flight: false })
    const ok = await send()
    assert.equal(ok.type, MSG.PAID)
    assert.equal(w.mock.orders.size, 1)
  })
})

test('a charge whose vault id the supplier never saved is refused before any claim or request', async () => {
  const db = openDb(':memory:')
  const spy = []
  await world({ supplierInjected: sdkInjection(db, spy) }, async (w) => {
    const deals = w.buyer.deals
    const deal = deals.startDeal({ mandateId: 'MND-A-LEAN', request: { sku: 'CUP-12-HOT', qty: 2 }, mode: 'policy', clientKey: 't' })
    await deals.sendRfq(deal, deal.request)
    await deals.counter(deal, { option_id: 'Q-0042-v1-a', pay_now: true })
    await deals.acceptQuote(deal, 'Q-0042-v2-a')
    assert.equal((await deals.verifyDeal(deal)).ok, true)
    db.put('negotiations', deal.quote_id, { ...db.get('negotiations', deal.quote_id), vault_id: 'VAULT-STRANGER' })
    const claims = { v: 1, payee: 'northbeam-supply', amount: fromCents(deal.accepted.option.total_cents), currency: 'USD', invoice_number: deal.draft.invoice_number, quote_id: deal.quote_id, quote_hash: deal.accepted.quote_hash, mandate_id: deal.mandate_id, nonce: 'nonce-stranger-1', exp: Math.floor(Date.now() / 1000) + 600 }
    await assert.rejects(() => w.buyer.ctx.supplier.send(MSG.COSIGN, deal.task_id, { quote_id: deal.quote_id, cosign_jws: signJws(claims, w.buyer.ctx.signer) }, 'northbeam-supply'), /not one this supplier stored/)
    assert.equal(db.get('cosigns', claims.nonce), null, 'no claim row')
    assert.equal(spy.filter((c) => c.path === '/v2/checkout/orders').length, 0)
  })
})

test('the human flow through the SDK: order claim, capture claim, and a second finish does not capture again', async () => {
  const db = openDb(':memory:')
  const spy = []
  await world({ connect: false, supplierInjected: sdkInjection(db, spy) }, async (w) => {
    const made = await w.supplierApi('POST', '/api/human-quote', { sku: 'CUP-12-HOT', qty: 2, client_key: 'person' })
    const pay = await fetch(`${made.data.url}/pay`, { method: 'POST', redirect: 'manual' })
    assert.equal(pay.status, 302)
    const created = spy.find((c) => c.path === '/v2/checkout/orders')
    assert.equal(created.claims.find((c) => c.key === `order:${made.data.quote_id}`).state, 'CALLING')
    assert.equal(created.requestId, created.claims.find((c) => c.key.startsWith('order:')).request_id)
    const approveUrl = new URL(pay.headers.get('location'))
    const orderId = approveUrl.searchParams.get('order')
    const approve = await fetch(`${w.mockBase}/mock/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `order=${orderId}&payer=procurement&setup=` })
    const back = await fetch(approve.headers.get('location'))
    assert.match(await back.text(), /is paid/)
    const capture = spy.find((c) => c.path.endsWith('/capture'))
    assert.equal(capture.claims.find((c) => c.key === `capture:${orderId}`).state, 'CALLING')
    assert.equal(capture.prefer, 'return=representation')
    assert.equal(w.mock.captures.size, 1)
    // Opening the return link again must not capture twice.
    const again = await fetch(approve.headers.get('location'))
    assert.notEqual(again.status, 200)
    assert.equal(spy.filter((c) => c.path.endsWith('/capture')).length, 1)
    assert.equal(w.mock.captures.size, 1)
  })
})
