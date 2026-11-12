import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'
import { runDueRefunds } from '../supplier/refunds.js'
import { healthCheck } from '../supplier/refunds.js'
import { createLimits } from '../supplier/limits.js'
import { openDb } from '../shared/docdb.js'
import { loadSupplierConfig } from '../supplier/config.js'

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}
const A = { mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 }
const refundsOf = (w) => runDueRefunds({ db: w.supplier.ctx.db, config: w.supplier.ctx.config, paypalFor: w.supplier.ctx.paypalFor, limits: w.supplier.ctx.limits, events: w.supplier.ctx.events })

test('judge account: the charge is refunded automatically, the balance comes back, the invoice records the refund', async () => {
  await world({}, async (w) => {
    const before = w.mock.accounts.judge.balance
    const { data: deal } = await w.runDeal(A)
    assert.equal(w.mock.accounts.judge.balance, before - 24586)
    const results = await refundsOf(w)
    assert.deepEqual(results.map((r) => r.ok), [true])
    assert.equal(w.mock.accounts.judge.balance, before, 'net spend is zero')
    assert.equal(w.mock.refunds.size, 1)
    assert.equal(w.supplier.ctx.db.get('charges', deal.charged.capture_id).refunded, true)
    assert.equal([...w.mock.invoices.values()][0].status, 'REFUNDED')
    assert.equal((await refundsOf(w)).length, 0, 'a refund is not repeated')
  })
})

test('a pending sandbox refund is tracked, and the next refund is not scheduled twice', async () => {
  await world({ mock: { refundPending: true } }, async (w) => {
    await w.runDeal(A)
    await refundsOf(w)
    const job = w.supplier.ctx.db.list('refund_jobs')[0]
    assert.equal(job.state, 'pending_at_paypal')
    assert.equal((await refundsOf(w)).length, 0)
  })
})

test('procurement account is not refunded (it is the real-use account)', async () => {
  await world({ connect: false }, async (w) => {
    const { autoConnectMock } = await import('../supplier/vault.js')
    const { db, config, primary } = w.supplier.ctx
    const setup = await primary.createSetupToken({ returnUrl: 'x', cancelUrl: 'y' })
    w.mock.approveSetup(setup.id, 'procurement')
    const { completeVaultSetup } = await import('../supplier/vault.js')
    db.put('vault_setups', setup.id, { setup_id: setup.id, buyer_id: 'brightcup-cafes' })
    config.judge.emails = ['judge-buyer@brightcup.example']
    const vault = await completeVaultSetup({ db, config, paypal: primary, setupId: setup.id })
    assert.equal(vault.account_kind, 'procurement')
    assert.equal(typeof autoConnectMock, 'function')
    await w.runDeal({ ...A })
    assert.equal(db.list('refund_jobs').length, 0)
  })
})

test('daily limits: per client and in total, then the same flow runs on simulated calls with the notice', async () => {
  const db = openDb(':memory:')
  const config = loadSupplierConfig()
  config.judge = { ...config.judge, perClientPerDay: 3, perDay: 5 }
  const limits = createLimits({ db, config })
  const ask = (client) => limits.decideRail({ clientKey: client, paypalMode: 'sandbox', accountKind: 'judge', amountCents: 24586 })
  assert.deepEqual([ask('c1').rail, ask('c1').rail, ask('c1').rail], ['live', 'live', 'live'])
  assert.deepEqual(ask('c1'), { rail: 'simulated', reason: 'client_daily' })
  assert.equal(ask('c2').rail, 'live')
  assert.equal(ask('c2').rail, 'live')
  assert.deepEqual(ask('c3'), { rail: 'simulated', reason: 'daily_total' })
  assert.equal(limits.status('c1').used_today, 5)
  assert.equal(limits.decideRail({ clientKey: 'c9', paypalMode: 'mock', accountKind: 'judge', amountCents: 1 }).rail, 'mock')
})

test('low judge balance stops new live charges and shows the simulated flow', async () => {
  const db = openDb(':memory:')
  const config = loadSupplierConfig()
  const limits = createLimits({ db, config })
  limits.setBalance(config.judge.minBalanceCents + 1000)
  assert.deepEqual(limits.decideRail({ clientKey: 'c', paypalMode: 'sandbox', accountKind: 'judge', amountCents: 24586 }), { rail: 'simulated', reason: 'low_balance' })
  assert.equal(limits.status('c').low_balance, false)
  limits.adjustBalance(-5000)
  assert.equal(limits.status('c').low_balance, true)
})

test('over the daily limit the deal still completes, on simulated PayPal calls, and does not count as a live charge', async () => {
  await world({}, async (w) => {
    // Pretend the supplier talks to a real sandbox so the live limits apply; the calls still go to the mock process.
    Object.defineProperty(w.supplier.ctx.primary, 'mode', { value: 'sandbox' })
    w.supplier.ctx.config.judge.perClientPerDay = 1
    const first = await w.runDeal({ ...A, client_key: 'judge-1' })
    assert.equal(first.data.charged.rail, 'live')
    const second = await w.runDeal({ ...A, client_key: 'judge-1' })
    assert.equal(second.data.status, 'paid')
    assert.equal(second.data.charged.rail, 'simulated')
    assert.equal(second.data.draft.rail_reason, 'client_daily')
    const { data } = await w.supplierApi('GET', '/api/state?client=judge-1')
    assert.match(data.notices.simulation, /simulated PayPal calls/)
    assert.equal(data.limits.used_today, 1)
    // The buyer's audit does not call the simulated deal a missing charge.
    const { data: audit } = await w.buyerApi('POST', '/api/audit/run')
    assert.equal(audit.alerts.length, 0)
  })
})

test('daily health check: a one-dollar charge and refund prove the saved PayPal still works', async () => {
  await world({}, async (w) => {
    const { db, config, paypalFor, events } = w.supplier.ctx
    const r = await healthCheck({ db, config, paypalFor, vault: db.get('vaults', 'brightcup-cafes'), events, cosign: { hash: 'seedhash', invoiceId: 'HEALTH-2026-11-12' } })
    assert.equal(r.ok, true)
    assert.equal(db.get('health', 'last').ok, true)
  })
})
