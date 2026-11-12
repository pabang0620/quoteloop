import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { startWorld } from './helpers.js'

const world = async (opts, fn) => {
  const w = await startWorld(opts)
  try { await fn(w) } finally { await w.close() }
}
const hook = (w, event, sig = 'MOCK-VALID-SIGNATURE') => w.supplierApi('POST', '/webhooks/paypal', event, {
  'paypal-transmission-sig': sig, 'paypal-transmission-id': 't1', 'paypal-transmission-time': new Date().toISOString(), 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
})
const paidEvent = (id, invoiceId) => ({ id, event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: invoiceId, status: 'PAID' } } })

test('INVOICING.INVOICE.PAID webhook marks a record_failed invoice paid once, after reading it back from PayPal', async () => {
  await world({}, async (w) => {
    const primary = w.supplier.ctx.primary
    // The payment recording fails at charge time, so the sale is stored as record_failed.
    const rec = primary.recordPayment
    primary.recordPayment = async () => { throw new Error('toolkit down') }
    primary.recordPaymentOther = async () => { throw new Error('toolkit down') }
    const deal = (await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })).data
    primary.recordPayment = rec
    const neg = w.supplier.ctx.db.get('negotiations', deal.quote_id)
    assert.equal(neg.charge.invoice_status, 'record_failed')

    // PayPal does not report the invoice as paid yet: the claim in the event body is not trusted.
    const early = await hook(w, paidEvent('WH-1', neg.invoice.invoice_id))
    assert.equal(early.data.handled, false)
    assert.equal(early.data.reason, 'invoice_not_paid_at_paypal')

    await primary.recordPaymentOther(neg.invoice.invoice_id, 24586, 'manual').catch(() => {})
    await primary.rest('POST', `/v2/invoicing/invoices/${neg.invoice.invoice_id}/payments`, { method: 'OTHER', amount: { currency_code: 'USD', value: '245.86' } })
    const done = await hook(w, paidEvent('WH-2', neg.invoice.invoice_id))
    assert.equal(done.data.handled, true)
    assert.equal(w.supplier.ctx.db.get('negotiations', deal.quote_id).charge.invoice_status, 'PAID')
    assert.ok(w.supplier.ctx.events.all().some((e) => e.kind === 'invoice_paid_webhook'))

    const again = await hook(w, paidEvent('WH-2', neg.invoice.invoice_id))
    assert.equal(again.data.reason, 'duplicate')
  })
})

test('webhook with a bad signature is refused and nothing changes; unknown invoices and other events are ignored', async () => {
  await world({}, async (w) => {
    const bad = await hook(w, paidEvent('WH-9', 'INV2-NOPE'), 'forged')
    assert.equal(bad.status, 400)
    assert.equal(w.supplier.ctx.db.get('webhook_events', 'WH-9'), null)
    const unknown = await hook(w, paidEvent('WH-10', 'INV2-NOPE'))
    assert.equal(unknown.data.reason, 'unknown_invoice')
    const other = await hook(w, { id: 'WH-11', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} })
    assert.equal(other.data.reason, 'ignored_event_type')
    const malformed = await hook(w, { event_type: 'INVOICING.INVOICE.PAID' })
    assert.equal(malformed.status, 400)
  })
})

test('price list: owner token required, floor and tiers are checked by code, and the next quote uses the new price', async () => {
  await world({ supplier: { adminToken: 'owner-secret' } }, async (w) => {
    const state = (await w.supplierApi('GET', '/api/state')).data
    assert.equal(state.price_edit_enabled, true)
    const noToken = await w.supplierApi('POST', '/api/price-list/CUP-12-HOT', { stock: 20 })
    assert.equal(noToken.status, 403)
    const h = { 'x-admin-token': 'owner-secret' }
    const underCost = await w.supplierApi('POST', '/api/price-list/CUP-12-HOT', { floor_cents: 7000 }, h)
    assert.equal(underCost.status, 400)
    const tierUnderFloor = await w.supplierApi('POST', '/api/price-list/CUP-12-HOT', { tiers: [{ min: 1, price_cents: 14000 }, { min: 2, price_cents: 11000 }] }, h)
    assert.equal(tierUnderFloor.status, 400)
    const extra = await w.supplierApi('POST', '/api/price-list/CUP-12-HOT', { cost_cents: 1 }, h)
    assert.equal(extra.status, 400)
    const ok = await w.supplierApi('POST', '/api/price-list/CUP-12-HOT', { tiers: [{ min: 1, price_cents: 13000 }, { min: 2, price_cents: 12000 }, { min: 3, price_cents: 11500 }] }, h)
    assert.equal(ok.status, 200)
    const deal = (await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })).data
    assert.ok(deal.accepted.option.total_cents < 24586, 'cheaper list gives a cheaper deal')
  })
})

test('price list is read-only without an owner token, and only one balance notice shows when both flags are set', async () => {
  const vite = await createServer({ root: 'web', appType: 'custom', server: { middlewareMode: true }, logLevel: 'silent' })
  const w = await startWorld()
  try {
    const { default: Notices } = await vite.ssrLoadModule('/src/components/Notices.jsx')
    const { default: Tabs } = await vite.ssrLoadModule('/src/components/Tabs.jsx')
    const sstate = (await w.supplierApi('GET', '/api/state')).data
    assert.equal(sstate.price_edit_enabled, false)
    const html = (el) => renderToString(el).replaceAll('<!-- -->', '')
    const both = { ...sstate, limits: { ...sstate.limits, low_balance: true } }
    const deal = { draft: { rail: 'simulated' } }
    const out = html(createElement(Notices, { buyer: { data: { vault: { connected: true } } }, supplier: { data: both }, deal }))
    assert.equal((out.match(/simulated PayPal calls/g) || []).length, 1)
    assert.match(out, /topped up/)
    assert.doesNotMatch(out, /Live sandbox runs used/)
    const tabs = html(createElement(Tabs, { buyer: null, supplier: sstate, buyerEvents: [], supplierEvents: [], onChanged() {} }))
    assert.match(tabs, /Price list/)
  } finally { await vite.close(); await w.close() }
})
