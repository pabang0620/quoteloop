import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'
import { supplierTools, createSession } from '../supplier/agent/tools.js'
import { buyerTools } from '../buyer/agent/tools.js'
import { toolSpecs } from '../shared/llm.js'

// A scripted stand-in for the Claude Messages API: each step is a list of tool calls (or a final text).
// It lets the tests drive the real tool loop and the real guards without any model call.
function scripted(steps) {
  let n = 0
  const seen = []
  return {
    seen,
    messages: {
      create: async ({ messages }) => {
        const last = messages.at(-1)
        const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result').map((b) => ({ ok: !b.is_error, body: JSON.parse(b.content) })) : []
        seen.push(results)
        const step = steps[n]
        n += 1
        if (!step) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
        const out = typeof step === 'function' ? step(results[0]?.body, results) : step
        if (typeof out === 'string') return { stop_reason: 'end_turn', content: [{ type: 'text', text: out }] }
        return { stop_reason: 'tool_use', content: out.map(([name, input], i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name, input })) }
      },
    },
  }
}

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}
const RFQ = ['send_rfq', { sku: 'CUP-12-HOT', qty: 2 }]

test('model mode and policy mode agree: a model that follows evaluate_quote ends at the same $245.86', async () => {
  const buyer = scripted([
    [['read_mandate', {}]], [['discover_supplier', {}]], [RFQ], [['evaluate_quote', {}]],
    (r) => [['counter', { option_id: r.recommendation.option_id, pay_now: r.recommendation.levers.pay_now }]],
    [['evaluate_quote', {}]],
    (r) => [['accept_quote', { option_id: r.recommendation.option_id }]],
    [['verify_draft', {}]], [['cosign_charge', {}]], 'Bought 2 cases for $245.86.',
  ])
  await world({ llm: { buyer: { model: 'scripted', client: buyer } } }, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude' })
    assert.equal(deal.status, 'paid')
    assert.equal(deal.accepted.option.total_cents, 24586)
    assert.equal(deal.log[0].kind, 'claude_summary')
    const policy = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'policy' })
    assert.equal(policy.data.accepted.option.total_cents, deal.accepted.option.total_cents)
  })
})

test('a model that picks the over-ordered option b gets an approval card, not a purchase', async () => {
  const buyer = scripted([[['discover_supplier', {}]], [RFQ], [['accept_quote', { option_id: 'Q-0042-v1-b' }]], 'b needs approval'])
  await world({ llm: { buyer: { model: 'scripted', client: buyer } } }, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude' })
    assert.equal(deal.status, 'awaiting_approval')
    const card = w.buyer.ctx.db.get('approvals', deal.approval_id)
    assert.ok(card.reasons.some((r) => r.text === '+50% quantity, +38% spend vs request, limit 10%'))
    assert.equal(w.mock.invoices.size, 0)
    assert.equal(w.mock.orders.size, 0)
  })
})

test('a model that skips verify_draft cannot co-sign: the tool refuses and code finishes the safe way', async () => {
  const buyer = scripted([
    [['discover_supplier', {}]], [RFQ], [['counter', { option_id: 'Q-0042-v1-a', pay_now: true }]],
    [['accept_quote', { option_id: 'Q-0042-v2-a' }]], [['cosign_charge', {}]], 'done',
  ])
  await world({ llm: { buyer: { model: 'scripted', client: buyer } } }, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude' })
    const refused = buyer.seen.flat().find((r) => !r.ok)
    assert.match(refused.body.error, /not passed verification/)
    assert.equal(deal.status, 'paid', 'the settlement steps ran in code: verify, then co-sign')
    assert.equal(w.mock.orders.size, 1)
  })
})

test('out of stock: the supplier model offers a same-category substitute and the buyer model accepts it inside the mandate', async () => {
  const supplierModel = scripted([
    [['list_catalog', {}]],
    [['price_options', { sku: 'CUP-12-RECYCLED', qty: 2 }]],
    [['issue_quote', { price_option_ids: ['po_1'], note: 'Hot cups are short this week; recycled-paper cups are in stock.' }]],
    'quoted a substitute',
    [['price_options', { sku: 'CUP-12-RECYCLED', qty: 2, pay_now: true }]],
    [['issue_quote', { price_option_ids: ['po_1'] }]],
    'repriced with pay-now',
  ])
  const buyerModel = scripted([
    [['discover_supplier', {}]], [RFQ], [['evaluate_quote', {}]],
    (r) => [['counter', { option_id: r.options[0].option_id, pay_now: true }]],
    [['accept_quote', { option_id: 'Q-0042-v2-a' }]],
    [['verify_draft', {}]], [['cosign_charge', {}]], 'bought the substitute',
  ])
  await world({ llm: { buyer: { model: 'scripted', client: buyerModel }, supplier: { model: 'scripted', client: supplierModel } } }, async (w) => {
    w.supplier.ctx.db.put('catalog', 'CUP-12-HOT', { ...w.supplier.ctx.db.get('catalog', 'CUP-12-HOT'), stock: 5 })
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude' })
    const option = deal.rounds[0].quote.options[0]
    assert.deepEqual([option.sku, option.substitute_for], ['CUP-12-RECYCLED', 'CUP-12-HOT'])
    assert.equal(deal.rounds[0].decided_by, 'claude')
    assert.equal(deal.status, 'paid')
    assert.equal(deal.accepted.option.total_cents, 26507)
    assert.equal(w.supplier.ctx.db.get('catalog', 'CUP-12-RECYCLED').stock, 10)
    assert.equal(w.supplier.ctx.db.get('catalog', 'CUP-12-HOT').stock, 5)
  })
})

test('a substitute outside the mandate is never auto-accepted', async () => {
  await world({}, async (w) => {
    const mandate = w.buyer.ctx.db.get('mandates', 'MND-A-LEAN')
    const narrow = { ...mandate.mandate, mandate_id: 'MND-NARROW', checkout: { ...mandate.mandate.checkout, line_items: mandate.mandate.checkout.line_items.filter((l) => l.sku === 'CUP-12-HOT') } }
    const { storeMandate } = await import('../buyer/mandates.js')
    storeMandate(w.buyer.ctx.db, narrow, w.buyer.ctx.signer)
    const deals = w.buyer.deals
    const deal = deals.startDeal({ mandateId: 'MND-NARROW', request: { sku: 'CUP-12-HOT', qty: 2 }, mode: 'policy', clientKey: 't' })
    await deals.sendRfq(deal, deal.request)
    const quote = deal.rounds[0].quote
    const forged = { ...quote.options[0], sku: 'CUP-12-RECYCLED', option_id: 'x' }
    deal.rounds[0].quote = { ...quote, options: [forged] }
    await assert.rejects(() => deals.acceptQuote(deal, 'x'), /not in the mandate/)
  })
})

test('the supplier cannot be talked into a price: tools take option ids, never amounts', async () => {
  await world({}, async (w) => {
    const neg = { quote_id: 'Q-0042' }
    const sTools = supplierTools(w.supplier.ctx, createSession(neg, { sku: 'CUP-12-HOT', qty: 2 }, 1))
    const specs = Object.fromEntries(toolSpecs(sTools).map((t) => [t.name, Object.keys(t.input_schema.properties)]))
    assert.deepEqual(specs.price_options.sort(), ['pay_now', 'qty', 'sku'])
    assert.deepEqual(specs.issue_quote.sort(), ['note', 'price_option_ids'])
    const price = sTools.find((t) => t.name === 'price_options')
    assert.throws(() => price.run({ sku: 'GRN-BURR-64', qty: 1 }), /same category/)
    assert.throws(() => price.run({ sku: 'CUP-12-HOT', qty: 99 }), /Only \d+ cases/)
    const issue = sTools.find((t) => t.name === 'issue_quote')
    assert.throws(() => issue.run({ price_option_ids: ['po_99'] }), /Unknown price option/)
    const b = buyerTools(w.buyer.ctx, w.buyer.deals, { mandate_id: 'MND-A-LEAN', request: {}, rounds: [] })
    const bSpecs = Object.fromEntries(toolSpecs(b).map((t) => [t.name, Object.keys(t.input_schema.properties)]))
    for (const props of Object.values(bSpecs)) for (const p of props) assert.ok(!/amount|cents|total|usd|value/i.test(p), `buyer tool takes ${p}`)
  })
})

test('no model key: the model request falls back to the same rules and says so', async () => {
  await world({}, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude' })
    assert.equal(deal.status, 'paid')
    assert.ok(w.buyer.ctx.events.all().some((e) => e.kind === 'claude_unavailable'))
  })
})

test('model runs are capped per visitor: past the cap the deal runs on the same rules and says why', async () => {
  const model = () => scripted([[['discover_supplier', {}]], [RFQ], 'stopped'])
  await world({ buyer: { claudePerClientPerDay: 1 }, llm: { buyer: { model: 'scripted', client: model() } } }, async (w) => {
    const first = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude', client_key: 'visitor-one' })
    assert.equal(first.data.mode, 'claude')
    const second = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude', client_key: 'visitor-one' })
    assert.equal(second.data.mode, 'policy')
    assert.equal(second.data.status, 'paid')
    assert.match(w.buyer.ctx.events.all().find((e) => e.kind === 'claude_unavailable').note, /model runs for today are used up/)
  })
})

test('after the hackathon live window the model is never called', async () => {
  await world({ buyer: { llmLiveUntil: Date.now() - 1000 }, llm: { buyer: { model: 'scripted', client: scripted([]) } } }, async (w) => {
    const { data } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude' })
    assert.equal(data.mode, 'policy')
    assert.equal(data.status, 'paid')
  })
})
