import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { startWorld } from './helpers.js'
import { money } from '../shared/money.js'

// Render the real screens with the real data of real deals (paid, blocked, waiting for approval) and check the key text.
test('screens render the data of paid, blocked and approval-pending deals', async () => {
  const vite = await createServer({ root: 'web', appType: 'custom', server: { middlewareMode: true }, logLevel: 'silent' })
  const w = await startWorld()
  try {
    const load = async (p) => (await vite.ssrLoadModule(p)).default
    const BuyerPane = await load('/src/components/BuyerPane.jsx')
    const SupplierPane = await load('/src/components/SupplierPane.jsx')
    const Header = await load('/src/components/Header.jsx')
    const Notices = await load('/src/components/Notices.jsx')
    const Tabs = await import('/src/components/Tabs.jsx').catch(() => null) || await vite.ssrLoadModule('/src/components/Tabs.jsx')

    await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    await w.runDeal({ mandate_id: 'MND-B-BULK', sku: 'CUP-12-HOT', qty: 2 })
    await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'GRN-BURR-64', qty: 1 })
    const primary = w.supplier.ctx.primary
    const original = primary.createInvoiceDraft
    primary.createInvoiceDraft = (body) => original({ ...body, items: [...body.items, { name: 'Rush handling', quantity: '1', unit_amount: money(4000) }] })
    await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    await w.buyerApi('POST', '/api/audit/run')

    const state = (await w.buyerApi('GET', '/api/state')).data
    const sstate = (await w.supplierApi('GET', '/api/state')).data
    const bev = w.buyer.ctx.events.all()
    const sev = w.supplier.ctx.events.all()
    const html = (el) => renderToString(el).replaceAll('<!-- -->', '')
    const byStatus = (s) => state.deals.find((d) => d.status === s)

    const paidA = state.deals.find((d) => d.status === 'paid' && d.mandate_id === 'MND-A-LEAN')
    const a = html(createElement(BuyerPane, { state, deal: paidA, mandateId: 'MND-A-LEAN', events: bev, onChanged() {} }))
    assert.match(a, /MATCH/)
    assert.match(a, /\$245\.86/)
    assert.match(a, /filtered: \+50% quantity, \+38% spend vs request, limit 10%/)
    assert.match(a, /Cap = never above\. Reference = accept without asking\./)

    const paidB = state.deals.find((d) => d.status === 'paid' && d.mandate_id === 'MND-B-BULK')
    assert.match(html(createElement(BuyerPane, { state, deal: paidB, mandateId: 'MND-B-BULK', events: bev, onChanged() {} })), /Saved \$14\.02 vs accepting round 1/)

    const blocked = html(createElement(BuyerPane, { state, deal: byStatus('blocked'), mandateId: 'MND-A-LEAN', events: bev, onChanged() {} }))
    assert.match(blocked, /Line 2 &#x27;Rush handling \$40\.00&#x27; not in signed quote v2/)
    assert.match(blocked, /nothing charged/)

    const waiting = html(createElement(BuyerPane, { state, deal: byStatus('awaiting_approval'), mandateId: 'MND-A-LEAN', events: bev, onChanged() {} }))
    assert.match(waiting, /Approval needed/)
    assert.match(waiting, /auto-approve/)

    const sup = html(createElement(SupplierPane, { state: sstate, deal: paidA, events: sev }))
    assert.match(sup, /score \$96\.00/)
    assert.match(sup, /PAID/)
    assert.match(sup, /floor \$112\.00/)

    assert.match(html(createElement(Header, { mandates: state.mandates, mandateId: 'MND-A-LEAN', setMandateId() {}, mode: 'policy', setMode() {}, llm: true, llmLabel: 'Claude Sonnet (local account)', paypalMode: 'mock', text: '12oz hot cups, 2 cases', setText() {}, onRun() {}, running: false, onHuman() {}, deal: paidA, onChanged() {}, supplierBase: 'http://x', ck: 'c' })), /Run deal/)
    assert.match(html(createElement(Header, { mandates: state.mandates, mandateId: 'MND-A-LEAN', setMandateId() {}, mode: 'claude', setMode() {}, llm: true, llmLabel: 'Claude Sonnet (local account)', paypalMode: 'mock', text: 'x', setText() {}, onRun() {}, running: false, onHuman() {}, deal: paidA, onChanged() {}, supplierBase: 'http://x', ck: 'c' })), /the model reads this sentence[\s\S]*Claude Sonnet \(local account\)[\s\S]*bundled mock PayPal/)
    const traced = { ...paidA, mode: 'claude', model: { label: 'Claude Sonnet (local account)', name: 'claude-sonnet-5-5' }, tool_calls: [{ name: 'evaluate_quote', input: {}, ok: true, summary: 'recommends counter Q-1-v1-a' }, { name: 'counter', input: { option_id: 'Q-1-v1-a', pay_now: true }, ok: true, summary: 'quote v2 with 1 option(s)' }] }
    const traceHtml = html(createElement(BuyerPane, { state, deal: traced, mandateId: 'MND-A-LEAN', events: bev, onChanged() {} }))
    assert.match(traceHtml, /Claude Sonnet \(local account\)/)
    assert.match(traceHtml, /evaluate_quote[\s\S]*counter\(option_id: Q-1-v1-a, pay_now: true\)/)
    assert.match(html(createElement(BuyerPane, { state, deal: { ...paidA, fell_back: true }, mandateId: 'MND-A-LEAN', events: bev, onChanged() {} })), /model call failed/)
    assert.match(html(createElement(Notices, { buyer: { data: state }, supplier: { data: sstate }, deal: paidA, error: null })), /Judge (sandbox account|account on the bundled mock) \(balance auto-restored\)/)

    const T = await vite.ssrLoadModule('/src/components/Tabs.jsx')
    assert.match(html(createElement(T.Audit, { buyer: state })), /MND-A-LEAN/)
    assert.match(html(createElement(T.Activity, { buyer: state, onChanged() {} })), /matched/)
    assert.match(html(createElement(T.Messages, { events: bev, label: 'Buyer service' })), /deal_started|quote_received/)
    assert.match(html(createElement(T.Signatures, { buyer: state, supplier: sstate })), /Ed25519/)
    assert.match(html(createElement(T.Connect, { buyer: state })), /Connected: judge account/)
    assert.match(html(createElement(T.default, { buyer: state, supplier: sstate, buyerEvents: bev, supplierEvents: sev, onChanged() {} })), /Audit trail/)
  } finally {
    await w.close()
    await vite.close()
  }
})
