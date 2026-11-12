import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { startWorld } from './helpers.js'
import { loadRecordedRuns, loadSandboxEvidence } from '../buyer/builtin.js'
import { runToolLoop } from '../shared/llm.js'
import { auditActivity } from '../buyer/audit.js'
import { createSupplierApp, REFUND_DELAY_MOCK_MS } from '../supplier/app.js'
import { loadSupplierConfig } from '../supplier/config.js'
import { openDb } from '../shared/docdb.js'
import { z } from 'zod'

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const AMOUNT_KEYS = /amount|total|cents|usd|^price$|_price$/i

test('recorded runs are real account-mode runs with the tool order, amount-free inputs and the README numbers', () => {
  const runs = loadRecordedRuns()
  assert.deepEqual(runs.map((r) => r.id), ['m1-free-form', 'm2-substitute', 'm3-bulk-mandate'])
  for (const r of runs) {
    assert.match(r.label, /^Recorded run: Claude Sonnet, \d{4}-\d{2}-\d{2}$/)
    assert.equal(r.backend, 'account')
    assert.equal(r.outcome.decided_by, 'claude')
    const tools = r.buyer.steps.filter((s) => s.type === 'tool').map((s) => s.name)
    assert.deepEqual(tools.slice(0, 3), ['read_mandate', 'discover_supplier', 'send_rfq'], r.id)
    assert.ok(tools.indexOf('verify_draft') < tools.indexOf('cosign_charge'), `${r.id}: verify before co-sign`)
    const times = r.buyer.steps.map((s) => s.t_ms)
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${r.id}: steps in time order`)
    for (const s of [...r.buyer.steps, ...r.supplier.flatMap((x) => x.steps)]) {
      if (s.type === 'tool') assert.ok(!Object.keys(s.input).some((k) => AMOUNT_KEYS.test(k)), `${r.id}: ${s.name} has no amount input`)
    }
    assert.ok(r.supplier.length >= 1 && r.supplier.every((x) => x.steps.some((s) => s.type === 'tool' && s.name === 'issue_quote')), `${r.id}: the supplier model issued each quote`)
  }
  const [m1, m2, m3] = runs
  assert.equal(m1.outcome.total_cents, 24586)
  assert.equal(m2.outcome.sku, 'CUP-12-RECYCLED')
  assert.equal(m2.outcome.total_cents, 26507)
  assert.equal(m3.outcome.qty, 3)
  assert.equal(m3.outcome.total_cents, 33998)
})

test('the page gets the recorded runs and the sandbox evidence from the buyer service', async () => {
  await world({}, async (w) => {
    const runs = await w.buyerApi('GET', '/api/recorded-runs')
    assert.equal(runs.data.runs.length, 3)
    const ev = await w.buyerApi('GET', '/api/sandbox-evidence')
    assert.ok(ev.data.passed.length >= 9)
    const state = await w.buyerApi('GET', '/api/state')
    assert.equal(state.data.llm_available, false, 'no model here, so the page offers the recording instead')
  })
})

test('sandbox evidence matches VERIFY.md: every PASS row and id is there, nothing that failed is listed as passed', () => {
  const ev = loadSandboxEvidence()
  const verify = read('VERIFY.md')
  const row = (id) => verify.split('\n').find((l) => l.startsWith(`| ${id} |`)) || ''
  for (const p of ev.passed) {
    assert.match(row(p.id), /PASS/, `VERIFY ${p.id} says PASS`)
    for (const token of p.evidence.join(' ').match(/\b[A-Z0-9][A-Za-z0-9-]{9,}\b/g) || []) assert.ok(verify.includes(token), `${token} is in VERIFY.md`)
  }
  for (const n of ev.not_passed) {
    const r = row(n.id)
    assert.ok(r, `VERIFY has row ${n.id}`)
    if (n.status !== 'NOT RUN') assert.match(r, new RegExp(`Result 2026-11-12: (${n.status}|FAIL)`), `VERIFY ${n.id} is ${n.status}`)
  }
  const ids = new Set([...ev.passed, ...ev.not_passed].map((x) => x.id))
  for (const n of ['7', '8']) assert.ok(!ev.passed.some((p) => p.id === n), `${n} is not claimed`)
  assert.equal(ids.size, ev.passed.length + ev.not_passed.length)
})

test('mock-mode waits are short by default: 2 minute refund on the bundled mock, activity rows say when to check again', async () => {
  const s = createSupplierApp({ dbFile: ':memory:', keyFile: '', judge: { ...loadSupplierConfig().judge, autoRefundDelayMs: null } }, { db: openDb(':memory:'), llm: null })
  assert.equal(s.ctx.primary.mode, 'mock')
  assert.equal(s.ctx.config.judge.autoRefundDelayMs, REFUND_DELAY_MOCK_MS)
  await world({ mock: { txnLagMs: 120000 }, buyer: { searchLagMs: 120000 } }, async (w) => {
    const deal = (await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })).data
    assert.equal(deal.status, 'paid')
    assert.ok(deal.charged.at, 'the charge time is kept for the page')
    const audit = await auditActivity({ db: w.buyer.ctx.db, paypal: w.buyer.ctx.paypal, config: w.buyer.ctx.config, visitor: 'testvisitor' })
    const pending = audit.rows.find((r) => r.status === 'pending')
    assert.ok(pending, 'the new charge is pending')
    assert.match(pending.note, /2 min/)
    assert.equal(Date.parse(pending.visible_by) - Date.parse(pending.at), 120000)
  })
})

test('the API tool loop keeps what the model wrote and when each tool ran, for recorded runs', async () => {
  let n = 0
  const client = { messages: { create: async () => (n++ === 0
    ? { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Reading the mandate first.' }, { type: 'tool_use', id: 't1', name: 'echo', input: { x: 1 } }] }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }) } }
  const tools = [{ name: 'echo', description: 'echo', schema: z.object({ x: z.number() }), run: ({ x }) => ({ x }) }]
  const out = await runToolLoop({ client, model: 'm', system: 's', userText: 'u', tools })
  assert.deepEqual(out.steps.map((s) => s.type), ['text', 'tool', 'text'])
  assert.equal(out.steps[1].index, 0)
  assert.ok(out.calls[0].t_ms >= 0 && out.duration_ms >= out.calls[0].t_ms)
})

test('submission docs: no placeholders, no em-dash, no balance-limit claim, same step names, video under 2:50', () => {
  const docs = ['README.md', 'DEVPOST.md', 'docs/VIDEO_SCRIPT.md', 'VERIFY.md']
  for (const f of docs) {
    assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${f} exists`)
    const t = read(f)
    assert.ok(!t.includes('\u2014'), `${f} has no em-dash`)
    assert.ok(!/loss ceiling/i.test(t), `${f} makes no loss-ceiling claim`)
    if (f !== 'VERIFY.md') assert.ok(!/\b(TODO|FILL|TBD|CHECK ME)\b|<[a-z ]+>/.test(t), `${f} has no placeholder`)
  }
  const video = read('docs/VIDEO_SCRIPT.md')
  const ends = [...video.matchAll(/\|\s*\d:\d{2}-(\d):(\d{2})\s*\|/g)].map((m) => Number(m[1]) * 60 + Number(m[2]))
  assert.ok(ends.length >= 8, 'scene rows with timings')
  assert.ok(Math.max(...ends) < 170, 'under 2:50')
  const readme = read('README.md')
  const devpost = read('DEVPOST.md')
  for (const name of ['Run deal', 'B Bulk', 'Compare A vs B', 'Demo controls', 'PayPal activity', 'Resume', 'Buyer with no agent', 'Claude runs', 'Sandbox evidence', '$245.86', '$339.98', '$14.02', '$1,180.00']) {
    for (const [f, t] of [['README', readme], ['DEVPOST', devpost], ['VIDEO_SCRIPT', video]]) assert.ok(t.includes(name), `${f} uses "${name}"`)
  }
  assert.match(devpost, /Why this is good for PayPal/)
  assert.match(devpost, /First user/)
})

test('a quote-link payment by a business with no agent is not an alert in Brightcup\'s own PayPal activity', async () => {
  await world({}, async (w) => {
    const made = await w.supplierApi('POST', '/api/human-quote', { sku: 'CUP-12-HOT', qty: 2, client_key: 'walk' })
    const pay = await fetch(`${w.supplierUrl}/q/${made.data.quote_id}/pay`, { method: 'POST', redirect: 'manual' })
    const approveUrl = new URL(pay.headers.get('location'))
    const page = await (await fetch(approveUrl)).text()
    assert.match(page, /Walk-in buyer/)
    assert.doesNotMatch(page, /Judge account/, 'the person cannot pay from the account Brightcup\'s agent audits')
    const approve = await fetch(`${w.mockBase}/mock/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `order=${approveUrl.searchParams.get('order')}&payer=walkin&setup=` })
    const done = await fetch(approve.headers.get('location'))
    assert.match(await done.text(), /Paid/)
    const audit = await auditActivity({ db: w.buyer.ctx.db, paypal: w.buyer.ctx.paypal, config: w.buyer.ctx.config, visitor: 'walk' })
    assert.equal(audit.alerts.length, 0)
  })
})
