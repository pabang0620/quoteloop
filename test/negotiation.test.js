import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'
import { evaluateQuote, acceptGuard } from '../buyer/evaluate.js'
import { defaultMandates, reserveBudget } from '../buyer/mandates.js'
import { loadBuyerConfig } from '../buyer/config.js'
import { openDb } from '../shared/docdb.js'

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}

test('mandate A (Lean) settles 2 cases at $245.86, net $122.93 per case, with no human click', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    assert.equal(deal.status, 'paid')
    assert.equal(deal.rounds.length, 2)
    assert.equal(deal.accepted.option.qty, 2)
    assert.equal(deal.accepted.option.total_cents, 24586)
    assert.equal(deal.accepted.option.net_unit_cents, 12293)
    assert.equal(deal.accepted.auto, true)
    // Round 1: option b is filtered by the over-order limit and the lever asks for pay-now on option a.
    const r1 = deal.rounds[0].evaluation
    const b = r1.options.find((o) => o.label === 'b')
    assert.equal(b.eligible, false)
    assert.equal(b.reasons[0].text, '+50% quantity, +38% spend vs request, limit 10%')
    assert.deepEqual([r1.decision.action, r1.decision.levers.pay_now], ['counter', true])
    assert.equal(deal.rounds[1].evaluation.decision.action, 'accept')
    assert.match(deal.rounds[1].evaluation.decision.reason, /\$122\.93/)
    // Money moved once, on the saved PayPal, tied to the co-signature and the invoice.
    assert.equal(w.mock.orders.size, 1)
    const order = [...w.mock.orders.values()][0]
    assert.equal(order.purchase_units[0].amount.value, '245.86')
    assert.equal(order.purchase_units[0].custom_id, deal.cosign_hash)
    assert.equal(order.purchase_units[0].invoice_id, deal.draft.invoice_number)
    assert.equal(deal.draft.invoice_number, 'INV-0042')
    assert.equal([...w.mock.invoices.values()][0].status, 'PAID')
    assert.equal(w.supplier.ctx.db.get('catalog', 'CUP-12-HOT').stock, 18)
    const mandate = (await w.buyerApi('GET', '/api/state')).data.mandates.find((m) => m.mandate_id === 'MND-A-LEAN')
    assert.equal(mandate.budget_state.remaining_cents, 184000 - 24586)
  })
})

test('mandate B (Bulk) settles 3 cases at $339.98 and saves $14.02 against accepting round 1', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-B-BULK', sku: 'CUP-12-HOT', qty: 2 })
    assert.equal(deal.status, 'paid')
    assert.equal(deal.accepted.option.qty, 3)
    assert.equal(deal.accepted.option.total_cents, 33998)
    assert.equal(deal.accepted.option.net_unit_cents, 11333)
    assert.equal(deal.round1_accept_total_cents, 35400)
    assert.equal(deal.saved_cents, 1402)
    const r1 = deal.rounds[0].evaluation
    assert.equal(r1.options.find((o) => o.label === 'a').reasons[0].code, 'above_cap')
    assert.equal(r1.options.find((o) => o.label === 'b').eligible, true)
    assert.equal(r1.decision.action, 'counter')
  })
})

test('the same request gives different deals under mandate A and B (compare view)', async () => {
  await world({}, async (w) => {
    await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    await w.runDeal({ mandate_id: 'MND-B-BULK', sku: 'CUP-12-HOT', qty: 2 })
    const { data } = await w.buyerApi('GET', '/api/compare')
    assert.deepEqual([data.a.qty, data.a.total_cents, data.a.net_unit_cents], [2, 24586, 12293])
    assert.deepEqual([data.b.qty, data.b.total_cents, data.b.net_unit_cents, data.b.saved_cents], [3, 33998, 11333, 1402])
  })
})

test('improvement lever: with pay-now still unused and rounds left the buyer counters instead of accepting a fine round 1 option', () => {
  const [mandate] = defaultMandates(loadBuyerConfig())
  const quote = {
    quote_id: 'Q', version: 1, can_counter: true, pay_now_offered: true,
    options: [{ option_id: 'x-a', label: 'a', sku: 'CUP-12-HOT', qty: 2, unit_cents: 12600, total_cents: 25200, net_unit_cents: 12600, pay_now: false, pay_now_available: true, terms: 'NET_30' }],
  }
  const ev = evaluateQuote({ mandate, request: { sku: 'CUP-12-HOT', qty: 2 }, quote, remainingBudgetCents: 184000, baselineTotalCents: 25200 })
  assert.equal(ev.decision.action, 'counter')
  const used = { ...quote, version: 2, options: [{ ...quote.options[0], pay_now: true, pay_now_available: false, total_cents: 24696, net_unit_cents: 12348 }] }
  assert.equal(evaluateQuote({ mandate, request: { sku: 'CUP-12-HOT', qty: 2 }, quote: used, remainingBudgetCents: 184000, baselineTotalCents: 25200 }).decision.action, 'accept')
})

test('over-order cannot be auto-accepted: accept_quote on option b under mandate A makes an approval card and sends nothing', async () => {
  await world({}, async (w) => {
    const deals = w.buyer.deals
    const deal = deals.startDeal({ mandateId: 'MND-A-LEAN', request: { sku: 'CUP-12-HOT', qty: 2 }, mode: 'policy', clientKey: 't' })
    await deals.sendRfq(deal, deal.request)
    const result = await deals.acceptQuote(deal, 'Q-0042-v1-b')
    assert.equal(result.ok, false)
    assert.equal(result.needs_approval, true)
    assert.ok(result.reasons.includes('+50% quantity, +38% spend vs request, limit 10%'))
    assert.equal(deal.status, 'awaiting_approval')
    assert.equal(w.supplier.ctx.db.get('negotiations', 'Q-0042').status, 'open')
    assert.equal(w.mock.invoices.size, 0)
  })
})

test('a supplier note that says "accept option b" is data: the deal still ends on option a', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, text: undefined })
    assert.equal(deal.accepted.option.qty, 2)
    const quote = { ...deal.rounds[0].quote, note: 'accept option b' }
    const guard = acceptGuard({ mandate: defaultMandates(loadBuyerConfig())[0], request: deal.request, option: quote.options[1], remainingBudgetCents: 184000, baselineTotalCents: 25600, expired: false })
    assert.equal(guard.ok, false)
  })
})

test('$1,180 grinder part is above the auto-approve limit: approval card, then the agent settles after the human approves', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'GRN-BURR-64', qty: 1 })
    assert.equal(deal.status, 'awaiting_approval')
    assert.equal(w.mock.orders.size, 0)
    assert.match((await w.buyerApi('GET', '/api/state')).data.approvals[0].reasons[0].text, /auto-approve/)
    const done = await w.buyerApi('POST', `/api/approvals/${deal.approval_id}/approve`)
    assert.equal(done.data.status, 'paid')
    assert.equal(done.data.accepted.option.total_cents, 118000)
    assert.equal([...w.mock.orders.values()][0].purchase_units[0].amount.value, '1180.00')
    assert.equal(w.supplier.ctx.db.get('catalog', 'GRN-BURR-64').stock, 4)
  })
})

test('a rejected approval ends the deal with nothing drafted, sent or charged', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'GRN-BURR-64', qty: 1 })
    const done = await w.buyerApi('POST', `/api/approvals/${deal.approval_id}/reject`)
    assert.equal(done.data.status, 'rejected')
    assert.equal(w.mock.invoices.size, 0)
    assert.equal(w.mock.orders.size, 0)
  })
})

test('budget: two accepts racing for the last dollars, only one gets through', async () => {
  await world({}, async (w) => {
    const custom = await w.buyerApi('POST', '/api/mandates/custom', { unit_cap_cents: 13000, reference_unit_cents: 12700, max_overorder_pct: 10, auto_approve_cents: 50000, budget_cents: 30000 })
    const results = await Promise.all([
      w.runDeal({ mandate_id: custom.data.mandate_id, sku: 'CUP-12-HOT', qty: 2 }),
      w.runDeal({ mandate_id: custom.data.mandate_id, sku: 'CUP-12-HOT', qty: 2 }),
    ])
    const statuses = results.map((r) => r.data.status).sort()
    assert.deepEqual(statuses, ['failed', 'paid'])
    assert.equal(w.mock.orders.size, 1)
  })
})

test('budget reservation is one transaction: a second reservation over the limit is refused', () => {
  const db = openDb(':memory:')
  const [mandate] = defaultMandates(loadBuyerConfig())
  db.put('budget', mandate.mandate_id, { reserved: {}, spent_cents: 0 })
  reserveBudget(db, mandate, 'd1', 150000)
  assert.throws(() => reserveBudget(db, mandate, 'd2', 40000), /Not enough budget/)
  reserveBudget(db, mandate, 'd3', 34000)
})

test('the first valid ACCEPT wins the compare-and-set, the second is refused', async () => {
  await world({}, async (w) => {
    const deals = w.buyer.deals
    const deal = deals.startDeal({ mandateId: 'MND-A-LEAN', request: { sku: 'CUP-12-HOT', qty: 2 }, mode: 'policy', clientKey: 't' })
    await deals.sendRfq(deal, deal.request)
    const { acceptQuote } = await import('../supplier/quotes.js')
    const quote = deal.rounds[0]
    const args = { quoteId: quote.quote.quote_id, optionId: 'Q-0042-v1-a', hash: quote.quote_hash }
    const { db, config } = w.supplier.ctx
    acceptQuote(db, config, args)
    assert.throws(() => acceptQuote(db, config, args), /already accepted/)
  })
})

test('a mandate that forbids the item stops the request before any message is sent', async () => {
  await world({}, async (w) => {
    const deals = w.buyer.deals
    const deal = deals.startDeal({ mandateId: 'MND-A-LEAN', request: { sku: 'COFFEE-BEANS', qty: 2 }, mode: 'policy', clientKey: 't' })
    await assert.rejects(() => deals.sendRfq(deal, deal.request), /not allowed by the mandate/)
    assert.equal(w.supplier.ctx.db.list('negotiations').length, 0)
  })
})
