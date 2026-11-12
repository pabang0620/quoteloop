import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'
import { runDueRefunds } from '../supplier/refunds.js'
import { runAccountLoop, withoutApiKey } from '../shared/accountLlm.js'
import { runModelLoop } from '../shared/llm.js'
import { z } from 'zod'

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}
const refundsNow = (w) => { const { db, config, paypalFor, limits, events } = w.supplier.ctx; return runDueRefunds({ db, config, paypalFor, limits, events }) }
const hot = (v, mandate) => ({ mandate_id: mandate, sku: 'CUP-12-HOT', qty: 2, client_key: v })
const grinder = (v) => ({ mandate_id: 'MND-A-LEAN', sku: 'GRN-BURR-64', qty: 1, client_key: v })

test('README steps 2 to 4 give the same numbers and the approval card to every visitor, and again on a repeat run', async () => {
  await world({}, async (w) => {
    for (const v of ['judge-one', 'judge-two', 'judge-three', 'judge-one']) {
      const a = (await w.runDeal(hot(v, 'MND-A-LEAN'))).data
      assert.equal(a.accepted.option.total_cents, 24586, `${v} A`)
      const b = (await w.runDeal(hot(v, 'MND-B-BULK'))).data
      assert.equal(b.accepted.option.total_cents, 33998, `${v} B`)
      assert.equal(b.saved_cents, 1402)
      const g = (await w.runDeal(grinder(v))).data
      assert.equal(g.status, 'awaiting_approval', `${v} grinder`)
      const done = await w.buyerApi('POST', `/api/approvals/${g.approval_id}/approve`, { client_key: v })
      assert.equal(done.data.status, 'paid')
      await refundsNow(w)
      const state = (await w.buyerApi('GET', '/api/state', { client_key: v })).data
      const lean = state.mandates.find((m) => m.mandate_id === 'MND-A-LEAN')
      assert.equal(lean.budget_state.remaining_cents, 184000, `${v} budget is back once the judge-account sales are refunded`)
    }
    assert.equal(w.supplier.ctx.db.get('catalog', 'CUP-12-HOT').stock, 18, 'judge sales never use up the shared stock')
  })
})

test('a visitor sees only their own deals and budget, and a client_key in the body does not change whose request it is', async () => {
  await world({}, async (w) => {
    await w.runDeal(hot('judge-one', 'MND-A-LEAN'))
    const one = (await w.buyerApi('GET', '/api/state', { client_key: 'judge-one' })).data
    const two = (await w.buyerApi('GET', '/api/state', { client_key: 'judge-two' })).data
    assert.equal(one.deals.length, 1)
    assert.equal(two.deals.length, 0)
    assert.equal(two.mandates.find((m) => m.mandate_id === 'MND-A-LEAN').budget_state.remaining_cents, 184000)
    // Cookie says judge-two; the body claims judge-one: the deal belongs to judge-two.
    const res = await fetch(`${w.buyerUrl}/api/deals`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'ql_visitor=judge-two' }, body: JSON.stringify({ ...hot('judge-one', 'MND-A-LEAN'), wait: true }) })
    assert.equal((await res.json()).data.client_key, 'judge-two')
    const other = await w.buyerApi('GET', `/api/deals/${one.deals[0].deal_id}`, { client_key: 'judge-two' })
    assert.equal(other.status, 404)
  })
})

test('the decline of a stock-limited visitor does not change what another visitor is quoted', async () => {
  await world({}, async (w) => {
    await w.supplierApi('POST', '/api/demo/low-stock', { on: true, client_key: 'judge-one' })
    const low = (await w.runDeal(hot('judge-one', 'MND-A-LEAN'))).data
    assert.equal(low.rounds[0].quote.options[0].substitute_for, 'CUP-12-HOT')
    const normal = (await w.runDeal(hot('judge-two', 'MND-A-LEAN'))).data
    assert.equal(normal.accepted.option.total_cents, 24586)
  })
})

test('audit: rogue charge, alert, Resume acknowledges it for good, the next audit does not pause again', async () => {
  await world({}, async (w) => {
    await w.supplierApi('POST', '/api/demo/rogue-charge', { client_key: 'judge-one' })
    const first = (await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-one' })).data
    assert.equal(first.alerts.length, 1)
    assert.equal((await w.buyerApi('GET', '/api/state', { client_key: 'judge-one' })).data.audit.state.paused, true)
    await w.buyerApi('POST', '/api/audit/resume', { client_key: 'judge-one' })
    const second = (await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-one' })).data
    assert.equal(second.alerts.length, 0)
    assert.ok(second.rows.some((r) => r.status === 'alert_acknowledged'))
    assert.equal((await w.buyerApi('GET', '/api/state', { client_key: 'judge-one' })).data.audit.state.paused, false)
  })
})

test('a demo rogue charge pauses only the visitor who pressed the button', async () => {
  await world({}, async (w) => {
    await w.supplierApi('POST', '/api/demo/rogue-charge', { client_key: 'judge-one' })
    await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-one' })
    const other = (await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-two' })).data
    assert.equal(other.alerts.length, 0)
    assert.equal((await w.runDeal(hot('judge-two', 'MND-A-LEAN'))).data.status, 'paid')
    assert.equal((await w.runDeal(hot('judge-one', 'MND-A-LEAN'))).data.status, 'failed')
  })
})

test('the daily check is co-signed by the buyer agent, so the audit matches it instead of raising an alert for everyone', async () => {
  await world({}, async (w) => {
    const result = await w.buyer.runDailyCheck()
    assert.equal(result.ok, true)
    const audit = (await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-one' })).data
    assert.equal(audit.alerts.length, 0)
    const row = audit.rows.find((r) => r.kind === 'charge' && r.amount === -1)
    assert.ok(row.status.startsWith('matched'), `daily check row is ${row.status}`)
    assert.equal((await w.runDeal(hot('judge-two', 'MND-A-LEAN'))).data.status, 'paid')
  })
})

test('the supplier refuses a daily check that carries no valid co-signature', async () => {
  await world({}, async (w) => {
    const { MSG } = await import('../shared/protocol.js')
    await assert.rejects(() => w.buyer.ctx.supplier.send(MSG.HEALTH_CHECK, 'health', { cosign_jws: 'not-a-jws' }, 'northbeam-supply'), /Co-signature check failed/)
    assert.equal(w.mock.orders.size, 0)
  })
})

test('co-signing paused: three deals in a row leave no reserved budget and every supplier draft is deleted', async () => {
  await world({}, async (w) => {
    await w.supplierApi('POST', '/api/demo/rogue-charge', { client_key: 'judge-one' })
    await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-one' })
    for (let i = 0; i < 3; i += 1) assert.equal((await w.runDeal(hot('judge-one', 'MND-A-LEAN'))).data.status, 'failed')
    const state = (await w.buyerApi('GET', '/api/state', { client_key: 'judge-one' })).data
    assert.equal(state.mandates.find((m) => m.mandate_id === 'MND-A-LEAN').budget_state.reserved_cents, 0)
    assert.deepEqual([...w.mock.invoices.values()].filter((i) => i.status === 'DRAFT'), [])
    assert.equal(w.supplier.ctx.db.list('reservations').length, 0)
  })
})

test('a missing Transaction Search permission shows an explanation card, not an error', async () => {
  await world({}, async (w) => {
    await w.runDeal(hot('judge-one', 'MND-A-LEAN'))
    w.buyer.ctx.paypal.listTransactions = async () => { const e = new Error('PayPal refused our credentials'); e.code = 'paypal_credentials'; throw e }
    const audit = (await w.buyerApi('POST', '/api/audit/run', { client_key: 'judge-one' })).data
    assert.equal(audit.unavailable.code, 'transaction_search_not_enabled')
    assert.equal(audit.alerts.length, 0)
    assert.ok(audit.rows.some((r) => r.status === 'unverified'))
    assert.match(audit.source, /mock|sandbox/)
  })
})

test('custom mandate budgets are capped, and belong to the visitor who signed them', async () => {
  await world({}, async (w) => {
    const body = { unit_cap_cents: 13000, reference_unit_cents: 12700, max_overorder_pct: 10, auto_approve_cents: 50000 }
    assert.equal((await w.buyerApi('POST', '/api/mandates/custom', { ...body, budget_cents: 99999999, client_key: 'judge-one' })).status, 400)
    const ok = await w.buyerApi('POST', '/api/mandates/custom', { ...body, budget_cents: 300000, client_key: 'judge-one' })
    assert.equal(ok.status, 201)
    const stolen = await w.runDeal({ mandate_id: ok.data.mandate_id, sku: 'CUP-12-HOT', qty: 2, client_key: 'judge-two' })
    assert.equal(stolen.status, 404)
  })
})

test('unknown approvals of another visitor are not decidable', async () => {
  await world({}, async (w) => {
    const g = (await w.runDeal(grinder('judge-one'))).data
    const res = await w.buyerApi('POST', `/api/approvals/${g.approval_id}/approve`, { client_key: 'judge-two' })
    assert.equal(res.status, 404)
  })
})

// ---- account backend: no API key, same tool shape ----

test('account backend: the API key variables are removed from the child environment', () => {
  const env = withoutApiKey({ ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin' })
  assert.deepEqual(env, { PATH: '/bin' })
})

test('account backend: model tool calls reach the real tools and come back in the same { text, calls } shape', async () => {
  let seenEnv = null
  const sdk = {
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    createSdkMcpServer: ({ tools }) => ({ tools }),
    query: ({ options }) => {
      seenEnv = options.env
      const tools = options.mcpServers.quoteloop.tools
      return (async function* () {
        await tools.find((t) => t.name === 'echo').handler({ text: 'hi' })
        await tools.find((t) => t.name === 'echo').handler({ text: 7 }).catch(() => {})
        yield { type: 'result', subtype: 'success', result: 'done' }
      })()
    },
  }
  const tools = [{ name: 'echo', description: 'echo', schema: z.object({ text: z.string() }), run: ({ text }) => ({ said: text }) }]
  const out = await runModelLoop({ model: 'claude-sonnet-5-5', backend: 'account', sdk }, { system: 's', userText: 'u', tools })
  assert.equal(out.text, 'done')
  assert.equal(out.calls[0].name, 'echo')
  assert.deepEqual(out.calls[0].result, { said: 'hi' })
  assert.ok(!('ANTHROPIC_API_KEY' in seenEnv))
  assert.equal(typeof runAccountLoop, 'function')
})

// ---- Claude mode on screen: free-form request, tool record, fallback ----
const scriptedModel = (steps) => {
  let n = 0
  return { messages: { create: async () => {
    const step = steps[n]
    n += 1
    if (!step) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
    if (step === 'throw') throw new Error('not logged in')
    if (typeof step === 'string') return { stop_reason: 'end_turn', content: [{ type: 'text', text: step }] }
    return { stop_reason: 'tool_use', content: step.map(([name, input], i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name, input })) }
  } } }
}

test('free-form request: the model passes item and quantity from the sentence, the deal records the tool calls and the model name', async () => {
  const buyer = scriptedModel([[['discover_supplier', {}]], [['send_rfq', { sku: 'CUP-12-HOT', qty: 2 }]], [['evaluate_quote', {}]], 'looked at the quote'])
  await world({ llm: { buyer: { model: 'scripted', client: buyer } } }, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', text: 'Could you get me a couple of 12oz hot cup cases, two cases is fine', mode: 'claude' })
    assert.equal(deal.request_text.startsWith('Could you'), true)
    assert.deepEqual(deal.request, { sku: 'CUP-12-HOT', qty: 2 })
    assert.deepEqual(deal.tool_calls.map((c) => c.name), ['discover_supplier', 'send_rfq', 'evaluate_quote'])
    assert.match(deal.tool_calls[2].summary, /recommends counter/)
    assert.equal(deal.model.name, 'scripted')
    for (const c of deal.tool_calls) assert.ok(!/cents|amount/i.test(JSON.stringify(c.input)))
  })
})

test('free-form request: a quantity the sentence does not contain is refused by code', async () => {
  const buyer = scriptedModel([[['discover_supplier', {}]], [['send_rfq', { sku: 'CUP-12-HOT', qty: 9 }]], 'stopped'])
  await world({ llm: { buyer: { model: 'scripted', client: buyer } } }, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', text: '12oz hot cups, 2 cases please', mode: 'claude' })
    assert.equal(deal.rounds.length, 0)
    assert.equal(deal.tool_calls[1].ok, false)
  })
})

test('the model call fails: the deal switches to the same tools run by rules and says so', async () => {
  await world({ llm: { buyer: { model: 'scripted', client: scriptedModel(['throw']) } } }, async (w) => {
    const { data: deal } = await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2, mode: 'claude' })
    assert.equal(deal.status, 'paid')
    assert.equal(deal.mode, 'policy')
    assert.equal(deal.fell_back, true)
    assert.ok(w.buyer.ctx.events.all().some((e) => e.kind === 'claude_unavailable' && /model call failed/.test(e.note)))
  })
})

test('"Saved vs round 1" is only counted when the round-1 option could have been accepted without asking', async () => {
  await world({}, async (w) => {
    const a = (await w.runDeal(hot('judge-one', 'MND-A-LEAN'))).data
    assert.equal(a.round1_acceptable, false)
    assert.equal(a.saved_cents || 0, 0)
    const b = (await w.runDeal(hot('judge-one', 'MND-B-BULK'))).data
    assert.equal(b.saved_cents, 1402)
  })
})
