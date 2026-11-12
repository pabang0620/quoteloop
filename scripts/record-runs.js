// Records real model runs for the page to replay when no model is connected (README "Where AI is used").
// Both agents run on Claude through the developer's own Claude Code login (account backend, the API key variables
// are removed from its environment). PayPal is the bundled mock, started in this process. Nothing else leaves the machine.
//
//   node scripts/record-runs.js            records every scenario that has no file yet
//   node scripts/record-runs.js m1-free-form
//
// An existing recording is never overwritten: move it away first if you want a new one.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startWorld } from '../test/helpers.js'
import { BUILTIN_DIR, recordedRunSchema } from '../buyer/builtin.js'

const MODEL = 'claude-sonnet-5-5'
const SCENARIOS = [
  { id: 'm1-free-form', title: 'Free-form request, mandate A Lean', mandate_id: 'MND-A-LEAN', text: 'We are running low on hot cups, please get us two cases of the 12oz ones by Friday', setup: [] },
  { id: 'm2-substitute', title: 'Hot cups short, the supplier model offers a substitute', mandate_id: 'MND-A-LEAN', text: 'Two cases of 12oz hot cups for Friday please', setup: ['12oz hot cups low on stock (this visitor only)'] },
  { id: 'm3-bulk-mandate', title: 'Same kind of request under mandate B Bulk', mandate_id: 'MND-B-BULK', text: 'Please order two cases of 12oz hot cups for Friday', setup: [] },
]

const supplierSummary = (c) => {
  if (!c.ok) return 'refused'
  if (c.name === 'price_options') return `priced ${c.input.qty} x ${c.input.sku}${c.input.pay_now ? ' with pay-now' : ''}`
  if (c.name === 'issue_quote') return `quote sent with ${c.input.price_option_ids?.length || 0} option(s)`
  if (c.name === 'list_catalog') return 'read the catalog and stock'
  return 'ok'
}

const toolStep = (s, call, summary) => ({ t_ms: s.t_ms, type: 'tool', name: call.name, input: call.input || {}, ok: Boolean(call.ok), summary })
const stepsOf = (steps, calls, summarize) => steps.map((s) => (s.type === 'text' ? s : toolStep(s, calls[s.index], summarize(calls[s.index]))))

async function record(scenario) {
  const file = join(BUILTIN_DIR, 'recorded-runs', `${scenario.id}.json`)
  if (existsSync(file)) {
    console.error(`${file} exists, skipped`)
    return
  }
  const llm = { model: MODEL, backend: 'account', client: null, key: '' }
  const w = await startWorld({ llm: { buyer: { ...llm }, supplier: { ...llm } } })
  try {
    const visitor = `rec-${scenario.id}`
    if (scenario.setup.length) await w.supplierApi('POST', '/api/demo/low-stock', { on: true, client_key: visitor })
    const started = new Date()
    const deal = (await w.runDeal({ mandate_id: scenario.mandate_id, text: scenario.text, mode: 'claude', visitor })).data
    if (!deal?.model_steps) throw new Error(`The deal did not run on the model: ${deal?.error || deal?.status}`)
    const rounds = w.supplier.ctx.events.all().filter((e) => e.kind === 'supplier_model_round' && e.quote_id === deal.quote_id)
    const option = deal.accepted?.option || null
    const run = {
      id: scenario.id,
      title: scenario.title,
      label: `Recorded run: Claude Sonnet, ${started.toISOString().slice(0, 10)}`,
      recorded_at: started.toISOString(),
      model: MODEL,
      backend: 'account',
      paypal: 'bundled mock',
      setup: scenario.setup,
      mandate_id: scenario.mandate_id,
      request_text: scenario.text,
      buyer: { steps: stepsOf(deal.model_steps, deal.tool_calls, (c) => c.summary), text: deal.model_text || '', duration_ms: deal.model_duration_ms || 0 },
      supplier: rounds.map((r) => ({ round: r.round, kind: r.round_kind, steps: stepsOf(r.steps, r.calls, supplierSummary), text: r.text, duration_ms: r.duration_ms || 0 })),
      outcome: { status: deal.status, quote_id: deal.quote_id, sku: option?.sku || null, qty: option?.qty || null, total_cents: option?.total_cents ?? null, decided_by: deal.decided_by },
    }
    writeFileSync(file, `${JSON.stringify(recordedRunSchema.parse(run), null, 2)}\n`)
    console.log(`${scenario.id}: ${deal.status}, ${option ? `${option.qty} x ${option.sku} ${option.total_cents} cents` : 'no option'}, ${deal.tool_calls.length} buyer tool calls, ${rounds.length} supplier rounds`)
  } finally {
    await w.close()
  }
}

const wanted = process.argv.slice(2)
for (const s of SCENARIOS.filter((x) => !wanted.length || wanted.includes(x.id))) {
  try {
    await record(s)
  } catch (err) {
    console.error(`${s.id} failed: ${err.message}`)
    process.exitCode = 1
  }
}
