import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'
import { auditActivity } from '../buyer/audit.js'
import { money } from '../shared/money.js'

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}
const A = { mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 }

test('audit pairs the charge in the buyer\'s own PayPal records with the co-signature it issued', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal(A)
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run')
    const row = audit.rows.find((r) => r.kind === 'charge')
    assert.equal(row.status, 'matched')
    assert.equal(row.cosign_hash, deal.cosign_hash)
    assert.equal(row.amount, -245.86)
    assert.equal(audit.alerts.length, 0)
  })
})

test('a charge with no co-signature raises an alert and stops further co-signing until a human resumes', async () => {
  await world({}, async (w) => {
    // The supplier (or anyone with the saved token) charges $19.99 without asking the buyer agent.
    const vaultId = w.supplier.ctx.db.get('vaults', 'brightcup-cafes').vault_id
    await w.supplier.ctx.primary.chargeVault({ vaultId, amountCents: 1999, invoiceId: 'INV-ROGUE', customId: 'not-a-cosign', requestId: 'rogue-1' })
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run')
    assert.equal(audit.alerts.length, 1)
    assert.equal(audit.alerts[0].amount, -19.99)
    const state = (await w.buyerApi('GET', '/api/state')).data
    assert.equal(state.audit.state.paused, true)
    const { data: deal } = await w.runDeal(A)
    assert.equal(deal.status, 'failed')
    assert.match(deal.error, /Co-signing is paused/)
    assert.equal(w.mock.orders.size, 1, 'only the rogue charge exists')
    await w.buyerApi('POST', '/api/audit/resume')
    const after = await w.runDeal(A)
    assert.equal(after.data.status, 'paid')
  })
})

test('refunds coming in are not charges: no false alarm, and the original shows refunded', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal(A)
    await w.supplier.ctx.primary.refundCapture(deal.charged.capture_id, 24586, deal.draft.invoice_number)
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run')
    assert.equal(audit.alerts.length, 0)
    const charge = audit.rows.find((r) => r.kind === 'charge')
    assert.equal(charge.refunded, true)
    assert.equal(charge.status, 'matched')
    const incoming = audit.rows.find((r) => r.kind === 'incoming')
    assert.equal(incoming.status, 'refund')
    assert.equal(incoming.refund_of, charge.transaction_id)
  })
})

test('an incoming payment that refunds nothing of ours is recorded quietly, with no alert', async () => {
  await world({}, async (w) => {
    w.mock.seedTransaction({ account: 'judge', id: 'GIFT00000000001XX', amount: '5.00', code: 'T0001' })
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run')
    assert.equal(audit.alerts.length, 0)
    assert.equal(audit.rows[0].status, 'unmatched_incoming')
  })
})

test('when the payer side cannot see the custom field, the audit falls back to amount and time and says so', async () => {
  await world({ mock: { payerSeesCustomField: false } }, async (w) => {
    await w.runDeal(A)
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run')
    assert.equal(audit.rows.find((r) => r.kind === 'charge').status, 'matched_weak')
    assert.equal(audit.alerts.length, 0)
  })
})

test('Transaction Search lag: a fresh deal is pending, an older one is matched', async () => {
  await world({ mock: { txnLagMs: 3 * 3600 * 1000 } }, async (w) => {
    await w.runDeal(A)
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run')
    assert.equal(audit.rows.find((r) => r.kind === 'cosign_only').status, 'pending')
    assert.equal(audit.alerts.length, 0)
    // Three hours pass: PayPal now shows the charge, so the same call matches it and the pending row is gone.
    for (const t of w.mock.txns) t.visibleAt = 0
    const later = await auditActivity({ db: w.buyer.ctx.db, paypal: w.buyer.ctx.paypal, config: w.buyer.ctx.config, visitor: 'testvisitor' })
    assert.equal(later.rows.find((r) => r.kind === 'charge').status, 'matched')
    assert.equal(later.rows.some((r) => r.status === 'pending'), false)
  })
})

test('the audit reads PayPal, not the supplier: it still raises the alarm when the supplier lies', async () => {
  await world({}, async (w) => {
    // A supplier that reports no charge at all still cannot hide it from the buyer's own record.
    const vaultId = w.supplier.ctx.db.get('vaults', 'brightcup-cafes').vault_id
    await w.supplier.ctx.primary.chargeVault({ vaultId, amountCents: 5000, invoiceId: 'INV-QUIET', customId: '', requestId: 'quiet-1' })
    assert.equal(w.supplier.ctx.db.list('charges').length, 0)
    const audit = await auditActivity({ db: w.buyer.ctx.db, paypal: w.buyer.ctx.paypal, config: w.buyer.ctx.config })
    assert.equal(audit.alerts.length, 1)
  })
})

test('mock PayPal refuses a charge above the payer balance (no fallback funding source)', async () => {
  await world({}, async (w) => {
    w.mock.accounts.judge.balance = 1000
    const vaultId = w.supplier.ctx.db.get('vaults', 'brightcup-cafes').vault_id
    await assert.rejects(() => w.supplier.ctx.primary.chargeVault({ vaultId, amountCents: 5000, invoiceId: 'INV-BIG', customId: 'x', requestId: 'big-1' }), /INSTRUMENT_DECLINED/)
    assert.deepEqual(money(5000), { currency_code: 'USD', value: '50.00' })
  })
})

test('amount and time fallback matching only claims the visiting buyer\'s own co-signature', async () => {
  const now = Date.parse('2026-11-12T10:00:00Z')
  const cosign = (hash, visitor) => ({ cosign_hash: hash, visitor, amount: 245.86, invoice_number: `INV-${hash}`, created_at: '2026-11-12T09:30:00Z', exp: now / 1000 + 600, state: 'charged', rail: 'sandbox' })
  const cosigns = [cosign('hashA', 'visitorA'), cosign('hashB', 'visitorB')]
  const store = new Map()
  const db = { list: () => cosigns, get: (t, k) => store.get(`${t}:${k}`), put: (t, k, v) => { store.set(`${t}:${k}`, v); return v } }
  // One charge of $245.86 with no custom field, as the payer side may show it.
  const paypal = { mode: 'sandbox', listTransactions: async () => ({ transaction_details: [{ transaction_info: { transaction_id: 'TX1', transaction_amount: { value: '-245.86' }, transaction_initiation_date: '2026-11-12T09:45:00Z' } }] }) }
  const config = { activitySide: 'payer', searchLagMs: 120000 }
  const run = (visitor) => auditActivity({ db, paypal, config, visitor, now })
  const a = await run('visitorA')
  assert.equal(a.rows.find((r) => r.transaction_id === 'TX1').cosign_hash, 'hashA')
  const c = await run('visitorC')
  const row = c.rows.find((r) => r.transaction_id === 'TX1')
  assert.equal(row.status, 'alert')
  assert.equal(row.cosign_hash, null)
})

test('the activity table says refunded after a refund', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal(A)
    await w.supplier.ctx.primary.refundCapture(deal.charged.capture_id, 24586, deal.draft.invoice_number)
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run')
    const { createServer } = await import('vite')
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    const vite = await createServer({ root: 'web', appType: 'custom', server: { middlewareMode: true }, logLevel: 'silent' })
    try {
      const T = await vite.ssrLoadModule('/src/components/Tabs.jsx')
      const state = (await w.buyerApi('GET', '/api/state')).data
      const html = renderToString(createElement(T.Activity, { buyer: { ...state, audit: { ...state.audit, last: audit } }, onChanged() {} }))
      assert.match(html, />refunded<\/span>/)
    } finally { await vite.close() }
  })
})
