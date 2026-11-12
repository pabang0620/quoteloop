import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'
import { verifyDraft } from '../buyer/verifyDraft.js'
import { loadSigningKey, signJws } from '../shared/jws.js'
import { fromCents, money } from '../shared/money.js'
import { MSG } from '../shared/protocol.js'
import { postJson } from '../shared/http.js'
import { getMandate } from '../buyer/mandates.js'
import { signMandate } from '../shared/mandate.js'

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}

// Negotiate mandate A by hand up to a verified draft, so each test can attack the next step.
async function toVerifiedDraft(w, { verify = true } = {}) {
  const deals = w.buyer.deals
  const deal = deals.startDeal({ mandateId: 'MND-A-LEAN', request: { sku: 'CUP-12-HOT', qty: 2 }, mode: 'policy', clientKey: 't' })
  await deals.sendRfq(deal, deal.request)
  await deals.counter(deal, { option_id: 'Q-0042-v1-a', pay_now: true })
  await deals.acceptQuote(deal, 'Q-0042-v2-a')
  if (verify) assert.equal((await deals.verifyDeal(deal)).ok, true)
  return deal
}

const claimsFor = (deal, over = {}) => ({
  v: 1, payee: 'northbeam-supply', amount: fromCents(deal.accepted.option.total_cents), currency: 'USD', invoice_number: deal.draft.invoice_number,
  quote_id: deal.quote_id, quote_hash: deal.accepted.quote_hash, mandate_id: deal.mandate_id, nonce: `nonce-${Math.random().toString(16).slice(2, 14)}`, exp: Math.floor(Date.now() / 1000) + 600, ...over,
})

const sendCosign = (w, deal, claims, signer = w.buyer.ctx.signer) =>
  w.buyer.ctx.supplier.send(MSG.COSIGN, deal.task_id, { quote_id: deal.quote_id, cosign_jws: signJws(claims, signer) }, 'northbeam-supply')

test('draft change detected: an extra "Rush handling $40.00" line is rejected, deleted, never sent, never charged', async () => {
  await world({}, async (w) => {
    const primary = w.supplier.ctx.primary
    const original = primary.createInvoiceDraft
    primary.createInvoiceDraft = (body) => original({ ...body, items: [...body.items, { name: 'Rush handling', quantity: '1', unit_amount: money(4000) }] })
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    assert.equal(deal.status, 'blocked')
    assert.ok(deal.draft.mismatches.includes("Line 2 'Rush handling $40.00' not in signed quote v2"))
    assert.ok(deal.draft.mismatches.some((m) => /Invoice total/.test(m)))
    assert.equal(w.mock.invoices.size, 0, 'the draft is deleted at PayPal')
    assert.equal(w.mock.orders.size, 0, 'nothing charged')
    assert.equal(w.supplier.ctx.db.get('negotiations', 'Q-0042').status, 'draft_rejected')
    assert.equal(w.supplier.ctx.db.get('catalog', 'CUP-12-HOT').stock, 18)
    const blocked = w.buyer.ctx.events.all().find((e) => e.kind === 'draft_blocked')
    assert.deepEqual([blocked.sent, blocked.charged], [false, false])
    const state = (await w.buyerApi('GET', '/api/state')).data
    assert.equal(state.mandates.find((m) => m.mandate_id === 'MND-A-LEAN').budget_state.remaining_cents, 184000)
    assert.equal(state.cosigns.length, 0, 'no co-signature was ever issued')
  })
})

test('draft check covers price, quantity, discount, PO, terms, recipient and number', async () => {
  await world({}, async (w) => {
    const deal = await toVerifiedDraft(w)
    const quote = deal.rounds[1].quote
    const base = { invoice: deal.draft.invoice, invoiceNumber: deal.draft.invoice_number, option: deal.accepted.option, quote, supplierName: 'Northbeam Supply', buyerEmail: 'ap@brightcup.example' }
    assert.equal(verifyDraft(base).ok, true)
    const clone = () => JSON.parse(JSON.stringify(base.invoice))
    const bad = (mutate) => { const inv = clone(); mutate(inv); return verifyDraft({ ...base, invoice: inv }) }
    assert.equal(bad((i) => { i.items[0].unit_amount.value = '126.00' }).ok, false)
    assert.equal(bad((i) => { i.items[0].quantity = '3' }).ok, false)
    assert.equal(bad((i) => { i.items[0].discount.amount.value = '0.00' }).ok, false)
    assert.equal(bad((i) => { i.items[0].discount = { percent: '2' } }).ok, false)
    assert.equal(bad((i) => { i.detail.reference = 'PO-OTHER' }).ok, false)
    assert.equal(bad((i) => { i.detail.payment_term.term_type = 'NET_30' }).ok, false)
    assert.equal(bad((i) => { i.primary_recipients[0].billing_info.email_address = 'someone@else.example' }).ok, false)
    assert.equal(bad((i) => { i.detail.invoice_number = 'INV-9999' }).ok, false)
    assert.equal(bad((i) => { i.status = 'SENT' }).ok, false)
    assert.equal(bad((i) => { i.amount.value = '250.00' }).ok, false)
    assert.equal(bad((i) => { i.detail.currency_code = 'EUR' }).ok, false)
  })
})

test('co-signature is refused unless the draft passed verification', async () => {
  await world({}, async (w) => {
    const deal = await toVerifiedDraft(w, { verify: false })
    await assert.rejects(() => w.buyer.deals.cosignAndCharge(deal), /not passed verification/)
    assert.equal(w.mock.orders.size, 0)
  })
})

test('forged, mismatched, expired co-signatures cannot make the supplier charge', async () => {
  await world({}, async (w) => {
    const deal = await toVerifiedDraft(w)
    const attempts = [
      ['wrong amount', claimsFor(deal, { amount: '245.87' }), undefined, /does not match the invoice/],
      ['higher amount', claimsFor(deal, { amount: '1245.86' }), undefined, /does not match the invoice/],
      ['expired', claimsFor(deal, { exp: Math.floor(Date.now() / 1000) - 5 }), undefined, /expired/],
      ['other payee', claimsFor(deal, { payee: 'someone-else' }), undefined, /another payee/],
      ['other invoice', claimsFor(deal, { invoice_number: 'INV-0099' }), undefined, /another invoice/],
      ['other quote hash', claimsFor(deal, { quote_hash: 'deadbeef' }), undefined, /another quote/],
      ['forged key', claimsFor(deal), loadSigningKey({}), /Co-signature check failed/],
    ]
    for (const [label, claims, signer, pattern] of attempts) {
      await assert.rejects(() => sendCosign(w, deal, claims, signer), pattern, label)
    }
    assert.equal(w.mock.orders.size, 0)
    assert.equal(w.mock.invoices.values().next().value.status, 'DRAFT', 'invoice was never sent')
  })
})

test('a co-signature works once: the same nonce, the same message or a second charge on the quote is refused', async () => {
  await world({}, async (w) => {
    const deal = await toVerifiedDraft(w)
    const claims = claimsFor(deal)
    const ok = await sendCosign(w, deal, claims)
    assert.equal(ok.type, MSG.PAID)
    assert.equal(w.mock.orders.size, 1)
    await assert.rejects(() => sendCosign(w, deal, claims), /nothing to charge|already used/)
    await assert.rejects(() => sendCosign(w, deal, claimsFor(deal)), /nothing to charge|already/)
    assert.equal(w.mock.orders.size, 1)
    assert.equal(w.mock.captures.size, 1)
  })
})

test('a replayed signed message is refused', async () => {
  await world({}, async (w) => {
    const jws = w.buyer.ctx.gate.sign(MSG.VAULT_STATUS, 'northbeam-supply', 't', {})
    await postJson(`${w.supplierUrl}/a2a/messages`, { jws })
    await assert.rejects(() => postJson(`${w.supplierUrl}/a2a/messages`, { jws }), /replay/i)
  })
})

test('PayPal-Request-Id makes a retried charge land once; a second order for the same invoice id is refused', async () => {
  await world({}, async (w) => {
    const deal = await toVerifiedDraft(w)
    const vaultId = w.supplier.ctx.db.get('vaults', 'brightcup-cafes').vault_id
    const paypal = w.supplier.ctx.primary
    const args = { vaultId, amountCents: 24586, invoiceId: deal.draft.invoice_number, customId: 'c1', requestId: 'req-1' }
    const first = await paypal.chargeVault(args)
    const again = await paypal.chargeVault(args)
    assert.equal(first.id, again.id)
    assert.equal(w.mock.captures.size, 1)
    await assert.rejects(() => paypal.chargeVault({ ...args, requestId: 'req-2' }), /DUPLICATE_INVOICE_ID/)
    assert.equal(w.mock.captures.size, 1)
  })
})

test('NET_30 terms are invoiced, not charged', async () => {
  await world({}, async (w) => {
    const deals = w.buyer.deals
    const deal = deals.startDeal({ mandateId: 'MND-A-LEAN', request: { sku: 'CUP-12-HOT', qty: 2 }, mode: 'policy', clientKey: 't' })
    await deals.sendRfq(deal, deal.request)
    await deals.acceptQuote(deal, 'Q-0042-v1-a', { approved: true })
    await deals.settle(deal)
    assert.equal(deal.status, 'invoiced_net30')
    assert.equal(w.mock.orders.size, 0)
  })
})

test('supplier code enforces its own per-charge limit', async () => {
  await world({ supplier: { perChargeLimitCents: 20000 } }, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    assert.equal(deal.status, 'failed')
    assert.match(deal.error, /per-charge limit/)
    assert.equal(w.mock.invoices.size, 0)
  })
})

test('supplier refuses a mandate it cannot verify, an expired one, or one for another merchant', async () => {
  await world({}, async (w) => {
    const deals = w.buyer.deals
    const deal = deals.startDeal({ mandateId: 'MND-A-LEAN', request: { sku: 'CUP-12-HOT', qty: 2 }, mode: 'policy', clientKey: 't' })
    const { quote, quote_hash } = await deals.sendRfq(deal, deal.request)
    const send = (jws) => w.buyer.ctx.supplier.send(MSG.ACCEPT, deal.task_id, { quote_id: quote.quote_id, option_id: quote.options[0].option_id, quote_hash, mandate_jws: jws, client_key: 't' }, 'northbeam-supply')
    const stored = getMandate(w.buyer.ctx.db, 'MND-A-LEAN')
    const signer = w.buyer.ctx.signer
    await assert.rejects(() => send(signMandate(stored.mandate, loadSigningKey({}))), /Mandate signature check failed/)
    await assert.rejects(() => send(signMandate({ ...stored.mandate, expires_at: new Date(Date.now() - 1000).toISOString() }, signer)), /Mandate expired/)
    await assert.rejects(() => send(signMandate({ ...stored.mandate, checkout: { ...stored.mandate.checkout, allowed_merchants: ['other-co'] } }, signer)), /not allowed by the mandate/)
    await assert.rejects(() => send(signMandate({ ...stored.mandate, checkout: { ...stored.mandate.checkout, line_items: stored.mandate.checkout.line_items.filter((l) => l.sku !== 'CUP-12-HOT') } }, signer)), /outside the mandate/)
    assert.equal(w.supplier.ctx.db.get('negotiations', 'Q-0042').status, 'open', 'no failed attempt closed the quote')
    assert.equal(w.mock.invoices.size, 0)
  })
})

test('keys are pinned: another key for the same buyer, or an unknown sender, is refused', async () => {
  await world({}, async (w) => {
    const rogue = loadSigningKey({})
    const { createGate } = await import('../shared/messages.js')
    const gate = createGate({ selfId: 'brightcup-cafes', signer: rogue, peerKey: () => w.supplier.ctx.signer.publicJwk })
    const jws = gate.sign(MSG.REGISTER, 'northbeam-supply', 'x', { public_jwk: rogue.publicJwk, company: 'Evil', billing_email: 'e@e.example' })
    await assert.rejects(() => postJson(`${w.supplierUrl}/a2a/messages`, { jws }), /different key is already pinned/)
    const stranger = createGate({ selfId: 'stranger', signer: rogue, peerKey: () => null })
    await assert.rejects(() => postJson(`${w.supplierUrl}/a2a/messages`, { jws: stranger.sign(MSG.RFQ, 'northbeam-supply', 'x', { sku: 'CUP-12-HOT', qty: 2 }) }), /Unknown sender/)
  })
})
