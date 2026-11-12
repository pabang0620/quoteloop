import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'
import { auditActivity } from '../buyer/audit.js'
import { openDb } from '../shared/docdb.js'

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}
const hot = (v) => ({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, client_key: v })

test('PayPal activity lists only this visitor\'s charges; other visitors\' judge-account charges are counted, not listed', async () => {
  await world({}, async (w) => {
    for (const v of ['judge-one', 'judge-two', 'judge-three']) await w.runDeal(hot(v))
    const mine = (await w.runDeal(hot('judge-four'))).data
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-four' })
    const charges = audit.rows.filter((r) => r.kind === 'charge')
    assert.equal(charges.length, 1)
    assert.equal(charges[0].cosign_hash, mine.cosign_hash)
    assert.equal(charges[0].status, 'matched')
    assert.equal(audit.other_visitors, 3)
    assert.equal(audit.alerts.length, 0)
    assert.ok(audit.rows.every((r) => !('owner' in r)), 'the owner field stays on the server')
  })
})

test('an unsigned charge that no visitor owns is still shown to everyone, and other visitors\' demo charges are not', async () => {
  await world({}, async (w) => {
    const vaultId = w.supplier.ctx.db.get('vaults', 'brightcup-cafes').vault_id
    await w.supplier.ctx.primary.chargeVault({ vaultId, amountCents: 1999, invoiceId: 'INV-ROGUE', customId: 'not-a-cosign', requestId: 'rogue-x' })
    const demo =await w.supplierApi('POST', '/api/demo/rogue-charge', { client_key: 'judge-one' })
    assert.ok(demo.success !== false, 'demo charge ran')
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-two' })
    const rows = audit.rows.filter((r) => r.kind === 'charge')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'alert')
    assert.equal(rows[0].invoice_id, 'INV-ROGUE')
  })
})

const txn = (id, value, extra = {}) => ({ transaction_info: { transaction_id: id, transaction_event_code: value > 0 ? 'T0003' : 'T1107', transaction_amount: { currency_code: 'USD', value: String(value) }, transaction_initiation_date: '2026-11-12T01:00:00Z', ...extra } })

test('payee-side sandbox view: signs are flipped and other merchants\' sales on the shared account are left out', async () => {
  const db = openDb()
  db.put('cosigns', 'h1', { cosign_hash: 'h1', amount: '245.86', invoice_number: 'INV-0050', quote_id: 'Q-0050', visitor: 'me', state: 'charged', created_at: '2026-11-12T00:59:00Z', exp: 1794448000 })
  const data = { transaction_details: [
    txn('CAP1', 245.86, { custom_field: 'h1', invoice_id: 'INV-0050' }),
    txn('REF1', -245.86, { invoice_id: 'INV-0050', paypal_reference_id: 'CAP1' }),
    txn('OTHER1', 70.29, { invoice_id: 'pkg-1-abc' }),
    txn('OTHER2', -70.29, { invoice_id: 'pkg-1-abc' }),
    txn('DEMO1', 19.99, { custom_field: 'supplier-did-not-ask:me', invoice_id: 'INV-ROGUE-1' }),
  ] }
  const paypal = { mode: 'sandbox', listTransactions: async () => data }
  const audit = await auditActivity({ db, paypal, config: { activitySide: 'payee', searchLagMs: 0 }, visitor: 'me', now: Date.parse('2026-11-12T02:00:00Z') })
  assert.equal(audit.side, 'payee')
  assert.equal(audit.ignored, 2)
  const charge = audit.rows.find((r) => r.transaction_id === 'CAP1')
  assert.equal(charge.status, 'matched')
  assert.equal(charge.amount, -245.86)
  assert.equal(charge.refunded, true)
  assert.equal(audit.rows.find((r) => r.transaction_id === 'REF1').status, 'refund')
  assert.equal(audit.alerts.length, 1)
  assert.equal(audit.alerts[0].transaction_id, 'DEMO1')
})

test('a settled deal counts its signed messages, so the page can say how the loop closed', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal(hot('judge-five'))
    assert.equal(deal.status, 'paid')
    assert.equal(deal.signed_messages, 8, 'RFQ, COUNTER, ACCEPT and COSIGN, each with a signed reply')
    assert.ok(deal.accepted.auto)
  })
})
