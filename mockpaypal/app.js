import express from 'express'
import { errorHandler, HttpError } from '../shared/http.js'
import { createState } from './state.js'

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;background:#f5f7fa;color:#1c2b39}main{max-width:420px;margin:48px auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 12px #0001}
h1{font-size:20px;margin:0 0 4px}p{color:#5a6b7b}button{display:block;width:100%;margin:10px 0;padding:12px;border:0;border-radius:8px;background:#0070e0;color:#fff;font-size:16px;cursor:pointer}small{color:#8a97a5}</style><main>${body}</main>`

export function createMockPaypalApp(options = {}) {
  const state = createState(options)
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false }))
  const auth = (req) => state.accountFor(req.get('authorization'))

  app.post('/v1/oauth2/token', (req, res, next) => {
    try {
      const basic = Buffer.from(String(req.get('authorization') || '').replace(/^Basic\s+/i, ''), 'base64').toString('utf8')
      const [clientId, secret] = basic.split(':')
      res.json(state.issueToken(clientId, secret))
    } catch (err) { next(err) }
  })

  // ---- Vault ----
  app.post('/v3/vault/setup-tokens', (req, res, next) => {
    try { res.status(201).json(state.createSetupToken(auth(req), req.body)) } catch (err) { next(err) }
  })
  app.post('/v3/vault/payment-tokens', (req, res, next) => {
    try { res.status(200).json(state.createPaymentToken(auth(req), req.body)) } catch (err) { next(err) }
  })
  app.get('/v3/vault/payment-tokens/:id', (req, res, next) => {
    try { res.json(state.getPaymentToken(auth(req), req.params.id)) } catch (err) { next(err) }
  })
  app.delete('/v3/vault/payment-tokens/:id', (req, res, next) => {
    try {
      const token = state.vault.get(req.params.id)
      if (token) token.active = false
      res.status(204).end()
    } catch (err) { next(err) }
  })

  // ---- Payer approval screen (stands in for PayPal's own login and consent page) ----
  app.get('/mock/approve', (req, res) => {
    const { setup, order } = req.query
    // Saving PayPal is Brightcup's step (judge or procurement account). A quote-link payment is made by another business with no agent.
    const LABELS = { judge: 'Judge account (refunded automatically)', procurement: 'Procurement account ($1,840 balance)', walkin: 'Walk-in buyer\'s PayPal (a business with no agent)' }
    const rows = (setup ? ['judge', 'procurement'] : ['walkin']).map((k) => `<button name="payer" value="${k}">${LABELS[k]}</button>`).join('')
    res.send(page('Mock PayPal', `<h1>Mock PayPal (sandbox stand-in)</h1><p>${setup ? 'Save PayPal for future purchases with Northbeam Supply.' : 'Approve this payment to Northbeam Supply.'}</p><form method="post" action="/mock/approve"><input type="hidden" name="setup" value="${setup || ''}"><input type="hidden" name="order" value="${order || ''}">${rows}</form><small>No real money moves.</small>`))
  })
  app.post('/mock/approve', (req, res, next) => {
    try {
      const { setup, order, payer } = req.body
      if (setup) {
        const rec = state.approveSetup(setup, payer)
        const url = new URL(rec.returnUrl || `${state.cfg.baseUrl}/mock/done`)
        url.searchParams.set('approval_token_id', setup)
        return res.redirect(url.toString())
      }
      const o = state.approveOrder(order, ['judge', 'procurement', 'walkin'].includes(payer) ? payer : 'walkin')
      const url = new URL(o.experience?.return_url || `${state.cfg.baseUrl}/mock/done`)
      url.searchParams.set('token', order)
      return res.redirect(url.toString())
    } catch (err) { next(err) }
  })
  app.get('/mock/done', (req, res) => res.send(page('Done', '<h1>Approved</h1><p>You can close this tab.</p>')))
  // JSON helper used by automated set-up (tests and the pre-connected demo account).
  app.post('/mock/auto-approve', (req, res, next) => {
    try { res.json(state.approveSetup(req.body.setup, req.body.payer)) } catch (err) { next(err) }
  })

  // ---- Orders and refunds ----
  app.post('/v2/checkout/orders', (req, res, next) => {
    try {
      const result = state.createOrder(auth(req), req.body, req.get('paypal-request-id'))
      res.status(result.status).json(result.body)
    } catch (err) { next(err) }
  })
  app.get('/v2/checkout/orders/:id', (req, res, next) => {
    try { res.json(state.getOrder(auth(req), req.params.id)) } catch (err) { next(err) }
  })
  app.post('/v2/checkout/orders/:id/capture', (req, res, next) => {
    try { res.status(201).json(state.captureOrder(auth(req), req.params.id)) } catch (err) { next(err) }
  })
  app.post('/v2/payments/captures/:id/refund', (req, res, next) => {
    try { res.status(201).json(state.refundCapture(auth(req), req.params.id, req.body)) } catch (err) { next(err) }
  })

  // ---- Invoicing ----
  app.post('/v2/invoicing/generate-next-invoice-number', (req, res, next) => {
    try { auth(req); res.json(state.nextInvoiceNumber()) } catch (err) { next(err) }
  })
  app.post('/v2/invoicing/invoices', (req, res, next) => {
    try { res.status(201).json(state.createInvoice(auth(req), req.body)) } catch (err) { next(err) }
  })
  app.get('/v2/invoicing/invoices/:id', (req, res, next) => {
    try { res.json(state.getInvoice(auth(req), req.params.id)) } catch (err) { next(err) }
  })
  app.post('/v2/invoicing/invoices/:id/send', (req, res, next) => {
    try { res.status(202).json(state.sendInvoice(auth(req), req.params.id, req.body)) } catch (err) { next(err) }
  })
  app.delete('/v2/invoicing/invoices/:id', (req, res, next) => {
    try { state.deleteInvoice(auth(req), req.params.id); res.status(204).end() } catch (err) { next(err) }
  })
  app.post('/v2/invoicing/invoices/:id/payments', (req, res, next) => {
    try { res.status(200).json(state.recordPayment(auth(req), req.params.id, req.body)) } catch (err) { next(err) }
  })
  app.post('/v2/invoicing/invoices/:id/refunds', (req, res, next) => {
    try { res.status(200).json(state.recordRefund(auth(req), req.params.id, req.body)) } catch (err) { next(err) }
  })

  // ---- Webhook signature check: the mock accepts the one marker signature a test or the VERIFY script sends ----
  app.post('/v1/notifications/verify-webhook-signature', (req, res, next) => {
    try {
      auth(req)
      res.json({ verification_status: req.body?.transmission_sig === 'MOCK-VALID-SIGNATURE' && req.body?.webhook_id ? 'SUCCESS' : 'FAILURE' })
    } catch (err) { next(err) }
  })

  // ---- Catalog, reporting ----
  app.post('/v1/catalogs/products', (req, res, next) => {
    try { res.status(201).json(state.createProduct(auth(req), req.body)) } catch (err) { next(err) }
  })
  app.get('/v1/reporting/transactions', (req, res, next) => {
    try { res.json(state.listTransactions(auth(req), req.query)) } catch (err) { next(err) }
  })
  app.get('/v1/reporting/balances', (req, res, next) => {
    try { res.json(state.balances(auth(req))) } catch (err) { next(err) }
  })

  // ---- Agent Toolkit stand-in: same tool names and arguments as @paypal/agent-toolkit ----
  const toolkit = {
    generate_invoice_number: (a) => state.nextInvoiceNumber(a),
    get_invoice: (acct, a) => state.getInvoice(acct, a.invoice_id),
    send_invoice: (acct, a) => state.sendInvoice(acct, a.invoice_id, a),
    delete_invoice: (acct, a) => state.deleteInvoice(acct, a.invoice_id),
    record_payment_for_invoice: (acct, a) => state.recordPayment(acct, a.invoice_id, a),
    record_refund_for_invoice: (acct, a) => state.recordRefund(acct, a.invoice_id, a),
    create_product: (acct, a) => state.createProduct(acct, a),
    list_products: (acct) => state.listProducts(acct),
    show_product_details: (acct, a) => state.showProduct(acct, a.product_id),
    create_refund: (acct, a) => state.refundCapture(acct, a.capture_id, a),
    list_transactions: (acct, a) => state.listTransactions(acct, a),
  }
  app.post('/mock/toolkit/:name', (req, res, next) => {
    try {
      const acct = auth(req)
      const fn = toolkit[req.params.name]
      if (!fn) throw new HttpError(400, `Mock toolkit has no tool ${req.params.name}`, 'unknown_tool')
      res.json(req.params.name === 'generate_invoice_number' ? fn(req.body) : fn(acct, req.body || {}))
    } catch (err) { next(err) }
  })

  // ---- Operator and test controls ----
  app.post('/mock/seed-transaction', (req, res, next) => {
    try { state.seedTransaction(req.body); res.json({ ok: true }) } catch (err) { next(err) }
  })
  app.post('/mock/settle-refunds', (req, res) => { state.settlePendingRefunds(); res.json({ ok: true }) })
  app.post('/mock/config', (req, res) => { Object.assign(state.cfg, req.body); res.json(state.cfg) })
  app.post('/mock/balance', (req, res, next) => {
    try {
      const acct = state.accounts[req.body.account]
      if (!acct) throw new HttpError(400, 'unknown account', 'INVALID_REQUEST')
      acct.balance = Math.round(Number(req.body.cents))
      res.json({ account: acct.key, balance_cents: acct.balance })
    } catch (err) { next(err) }
  })
  app.get('/mock/health', (req, res) => res.json({ ok: true, service: 'mock-paypal' }))

  app.use((req, res, next) => next(new HttpError(404, `No mock route ${req.method} ${req.path}`, 'not_found')))
  app.use(errorHandler)
  app.state = state
  return app
}
