import { randomBytes } from 'node:crypto'
import { HttpError } from '../shared/http.js'
import { fromCents, toCents } from '../shared/money.js'

// Stand-in for the PayPal sandbox. Response shapes follow PayPal's REST documentation and the
// @paypal/server-sdk models (vault_id, custom_id, invoice_id, captures[], transaction_info.custom_field).
// It runs as its own process, so the supplier and the buyer reach "PayPal" only over HTTP.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const pid = (n = 17) => Array.from(randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join('')
const nowIso = () => new Date().toISOString()

export function createState(options = {}) {
  const cfg = {
    txnLagMs: Number(options.txnLagMs ?? 0),
    payerSeesCustomField: options.payerSeesCustomField ?? true,
    refundPending: options.refundPending ?? false,
    baseUrl: options.baseUrl || 'http://localhost:4103',
  }
  const accounts = {
    supplier: { key: 'supplier', clientId: 'mock-supplier-client', secret: 'mock-supplier-secret', kind: 'merchant', balance: 0, email: 'sales@northbeam.example', merchantId: 'NBSUPPLY00001', payerId: 'NBSUPPLY00001' },
    judge: { key: 'judge', clientId: 'mock-buyer-judge-client', secret: 'mock-buyer-judge-secret', kind: 'payer', balance: 1000000, email: 'judge-buyer@brightcup.example', payerId: 'JUDGEPAYER001', fundingFallback: false },
    procurement: { key: 'procurement', clientId: 'mock-buyer-procurement-client', secret: 'mock-buyer-procurement-secret', kind: 'payer', balance: 184000, email: 'procurement@brightcup.example', payerId: 'PROCPAYER0001', fundingFallback: false },
    // A different business that pays a quote link by hand (the "Buyer with no agent" path). Brightcup's agent never reads it.
    walkin: { key: 'walkin', clientId: 'mock-walkin-client', secret: 'mock-walkin-secret', kind: 'payer', balance: 500000, email: 'buyer@walkin.example', payerId: 'WALKIN0000001', fundingFallback: false },
  }
  const tokens = new Map()
  const setupTokens = new Map()
  const vault = new Map()
  const orders = new Map()
  const captures = new Map()
  const refunds = new Map()
  const idem = new Map()
  const invoices = new Map()
  const products = new Map()
  const txns = []
  let invoiceCounter = 41

  const byClient = (clientId) => Object.values(accounts).find((a) => a.clientId === clientId)

  function issueToken(clientId, secret) {
    const acct = byClient(clientId)
    if (!acct || acct.secret !== secret) throw new HttpError(401, 'Client Authentication failed', 'invalid_client')
    const token = `MOCK.${acct.key}.${randomBytes(8).toString('hex')}`
    tokens.set(token, acct.key)
    return { access_token: token, token_type: 'Bearer', expires_in: 32400, scope: 'https://uri.paypal.com/services/reporting/search/read' }
  }

  function accountFor(authHeader) {
    const token = String(authHeader || '').replace(/^Bearer\s+/i, '')
    const key = tokens.get(token)
    if (!key) throw new HttpError(401, 'Authentication failed due to invalid authentication credentials', 'AUTHENTICATION_FAILURE')
    return accounts[key]
  }

  const requireMerchant = (acct) => {
    if (acct.kind !== 'merchant') throw new HttpError(403, 'NOT_AUTHORIZED: merchant only', 'NOT_AUTHORIZED')
  }

  // ---------- Vault ----------
  function createSetupToken(acct, body) {
    requireMerchant(acct)
    const paypal = body?.payment_source?.paypal
    if (!paypal || paypal.usage_type !== 'MERCHANT') throw new HttpError(422, 'INVALID_REQUEST: payment_source.paypal.usage_type must be MERCHANT', 'INVALID_REQUEST')
    const id = pid(12)
    const rec = { id, merchant: acct.key, status: 'PAYER_ACTION_REQUIRED', payer: null, returnUrl: paypal.experience_context?.return_url, cancelUrl: paypal.experience_context?.cancel_url, usage_pattern: paypal.usage_pattern || 'IMMEDIATE' }
    setupTokens.set(id, rec)
    return {
      id,
      customer: { id: `CUST${pid(8)}` },
      status: rec.status,
      payment_source: { paypal: { usage_type: 'MERCHANT', usage_pattern: rec.usage_pattern } },
      links: [{ href: `${cfg.baseUrl}/mock/approve?setup=${id}`, rel: 'approve', method: 'GET' }],
    }
  }

  function approveSetup(id, payerKey) {
    const rec = setupTokens.get(id)
    if (!rec) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND')
    if (!accounts[payerKey] || accounts[payerKey].kind !== 'payer') throw new HttpError(400, 'unknown payer account', 'INVALID_REQUEST')
    rec.status = 'APPROVED'
    rec.payer = payerKey
    return rec
  }

  function createPaymentToken(acct, body) {
    requireMerchant(acct)
    const src = body?.payment_source?.token
    const rec = setupTokens.get(src?.id)
    if (!rec || src.type !== 'SETUP_TOKEN') throw new HttpError(404, 'RESOURCE_NOT_FOUND: setup token', 'RESOURCE_NOT_FOUND')
    if (rec.status !== 'APPROVED') throw new HttpError(422, 'SETUP_TOKEN_NOT_APPROVED', 'PAYER_ACTION_REQUIRED')
    const id = pid(10)
    const payer = accounts[rec.payer]
    vault.set(id, { id, merchant: rec.merchant, payer: rec.payer, active: true })
    setupTokens.delete(src.id)
    return { id, customer: { id: `CUST${pid(8)}` }, payment_source: { paypal: { email_address: payer.email, payer_id: payer.payerId, usage_type: 'MERCHANT' } }, links: [] }
  }

  function getPaymentToken(acct, id) {
    requireMerchant(acct)
    const token = vault.get(id)
    if (!token || !token.active || token.merchant !== acct.key) throw new HttpError(404, 'RESOURCE_NOT_FOUND: payment token', 'RESOURCE_NOT_FOUND')
    const payer = accounts[token.payer]
    return { id, customer: { id: `CUST${pid(8)}` }, payment_source: { paypal: { email_address: payer.email, payer_id: payer.payerId, usage_type: 'MERCHANT' } }, links: [] }
  }

  // ---------- Orders and captures ----------
  function recordTxn(acct, { id, code, amount, invoiceId, customId, ref, status = 'S', at }) {
    const created = at || Date.now()
    txns.push({
      account: acct.key,
      visibleAt: created + cfg.txnLagMs,
      initiated: created,
      body: {
        transaction_info: {
          paypal_account_id: acct.payerId,
          transaction_id: id,
          ...(ref ? { paypal_reference_id: ref, paypal_reference_id_type: 'TXN' } : {}),
          transaction_event_code: code,
          transaction_initiation_date: new Date(created).toISOString(),
          transaction_updated_date: new Date(created).toISOString(),
          transaction_amount: { currency_code: 'USD', value: amount },
          transaction_status: status,
          invoice_id: invoiceId || undefined,
          ...(customId && (acct.kind === 'merchant' || cfg.payerSeesCustomField) ? { custom_field: customId } : {}),
        },
        payer_info: { account_id: acct.payerId, email_address: acct.email },
      },
    })
  }

  function capturePayment(order, payer, merchant, at) {
    const unit = order.purchase_units[0]
    const cents = toCents(unit.amount.value)
    if (payer.balance < cents && !payer.fundingFallback) throw new HttpError(422, 'INSTRUMENT_DECLINED: payer balance too low', 'INSTRUMENT_DECLINED')
    payer.balance -= cents
    merchant.balance += cents
    const capture = { id: pid(), status: 'COMPLETED', amount: { ...unit.amount }, invoice_id: unit.invoice_id, custom_id: unit.custom_id, final_capture: true, create_time: nowIso(), payer: payer.key, merchant: merchant.key }
    captures.set(capture.id, capture)
    unit.payments = { captures: [{ id: capture.id, status: 'COMPLETED', amount: capture.amount, invoice_id: capture.invoice_id, custom_id: capture.custom_id, final_capture: true, create_time: capture.create_time }] }
    order.status = 'COMPLETED'
    recordTxn(payer, { id: capture.id, code: 'T0006', amount: `-${fromCents(cents)}`, invoiceId: unit.invoice_id, customId: unit.custom_id, at })
    recordTxn(merchant, { id: capture.id, code: 'T0006', amount: fromCents(cents), invoiceId: unit.invoice_id, customId: unit.custom_id, at })
    return capture
  }

  function createOrder(acct, body, requestId) {
    requireMerchant(acct)
    const key = requestId ? `${acct.key}:${requestId}` : null
    if (key && idem.has(key)) return { replay: true, ...idem.get(key) }
    const unit = body?.purchase_units?.[0]
    if (!unit?.amount?.value || !(Number(unit.amount.value) > 0)) throw new HttpError(422, 'INVALID_REQUEST: amount', 'INVALID_REQUEST')
    if (unit.custom_id && unit.custom_id.length > 127) throw new HttpError(422, 'INVALID_PARAMETER_VALUE: custom_id', 'INVALID_PARAMETER_VALUE')
    if (unit.invoice_id && [...orders.values()].some((o) => o.merchant === acct.key && o.status === 'COMPLETED' && o.purchase_units[0].invoice_id === unit.invoice_id)) {
      throw new HttpError(400, 'DUPLICATE_INVOICE_ID', 'DUPLICATE_INVOICE_ID')
    }
    const id = pid()
    const order = {
      id, intent: 'CAPTURE', status: 'CREATED', merchant: acct.key, create_time: nowIso(),
      purchase_units: [{ reference_id: 'default', amount: { currency_code: unit.amount.currency_code, value: unit.amount.value }, payee: { email_address: acct.email, merchant_id: acct.merchantId }, invoice_id: unit.invoice_id, custom_id: unit.custom_id }],
      links: [{ href: `${cfg.baseUrl}/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' }],
    }
    const paypal = body.payment_source?.paypal
    if (paypal?.vault_id) {
      const token = vault.get(paypal.vault_id)
      if (!token || !token.active || token.merchant !== acct.key) throw new HttpError(422, 'INVALID_RESOURCE_ID: vault_id', 'INVALID_RESOURCE_ID')
      order.payer = token.payer
      capturePayment(order, accounts[token.payer], acct)
      order.payment_source = { paypal: { email_address: accounts[token.payer].email, account_id: accounts[token.payer].payerId } }
    } else {
      order.status = 'PAYER_ACTION_REQUIRED'
      order.experience = paypal?.experience_context || {}
      order.links.push({ href: `${cfg.baseUrl}/mock/approve?order=${id}`, rel: 'payer-action', method: 'GET' })
    }
    orders.set(id, order)
    const result = { status: 201, body: publicOrder(order) }
    if (key) idem.set(key, result)
    return result
  }

  function publicOrder(order) {
    const { merchant, payer, experience, ...rest } = order
    return JSON.parse(JSON.stringify(rest))
  }

  function approveOrder(id, payerKey) {
    const order = orders.get(id)
    if (!order) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND')
    order.status = 'APPROVED'
    order.payer = payerKey
    return order
  }

  function captureOrder(acct, id) {
    const order = orders.get(id)
    if (!order || order.merchant !== acct.key) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND')
    if (order.status !== 'APPROVED') throw new HttpError(422, 'ORDER_NOT_APPROVED', 'ORDER_NOT_APPROVED')
    capturePayment(order, accounts[order.payer], acct)
    return publicOrder(order)
  }

  function getOrder(acct, id) {
    const order = orders.get(id)
    if (!order || (order.merchant !== acct.key && order.payer !== acct.key)) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND')
    return publicOrder(order)
  }

  // ---------- Refunds ----------
  function refundCapture(acct, captureId, body = {}) {
    requireMerchant(acct)
    const capture = captures.get(captureId)
    if (!capture || capture.merchant !== acct.key) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND')
    const done = [...refunds.values()].filter((r) => r.capture_id === captureId).reduce((s, r) => s + toCents(r.amount.value), 0)
    const remaining = toCents(capture.amount.value) - done
    const cents = body.amount?.value ? toCents(body.amount.value) : remaining
    if (!(cents > 0) || cents > remaining) throw new HttpError(422, 'REFUND_AMOUNT_EXCEEDED', 'REFUND_AMOUNT_EXCEEDED')
    const refund = { id: pid(), status: cfg.refundPending ? 'PENDING' : 'COMPLETED', amount: { currency_code: 'USD', value: fromCents(cents) }, capture_id: captureId, invoice_id: body.invoice_id, note_to_payer: body.note_to_payer, create_time: nowIso() }
    refunds.set(refund.id, refund)
    if (!cfg.refundPending) settleRefund(refund)
    return { id: refund.id, status: refund.status, amount: refund.amount, links: [] }
  }

  function settleRefund(refund) {
    const capture = captures.get(refund.capture_id)
    const payer = accounts[capture.payer]
    const merchant = accounts[capture.merchant]
    const cents = toCents(refund.amount.value)
    payer.balance += cents
    merchant.balance -= cents
    refund.status = 'COMPLETED'
    recordTxn(payer, { id: refund.id, code: 'T1107', amount: fromCents(cents), invoiceId: refund.invoice_id, ref: capture.id })
    recordTxn(merchant, { id: refund.id, code: 'T1107', amount: `-${fromCents(cents)}`, invoiceId: refund.invoice_id, ref: capture.id })
  }

  function settlePendingRefunds() {
    for (const r of refunds.values()) if (r.status === 'PENDING') settleRefund(r)
  }

  // ---------- Invoicing ----------
  const nextInvoiceNumber = () => ({ invoice_number: String(++invoiceCounter).padStart(4, '0') })

  function invoiceTotals(items) {
    let itemTotal = 0
    let discount = 0
    for (const it of items) {
      itemTotal += toCents(it.unit_amount.value) * Number(it.quantity)
      discount += it.discount?.amount?.value ? toCents(it.discount.amount.value) : 0
    }
    return { itemTotal, discount, total: itemTotal - discount }
  }

  function createInvoice(acct, body) {
    requireMerchant(acct)
    if (!body?.items?.length) throw new HttpError(422, 'INVALID_REQUEST: items', 'INVALID_REQUEST')
    const id = `INV2-${pid(4)}-${pid(4)}-${pid(4)}-${pid(4)}`
    const t = invoiceTotals(body.items)
    const cur = body.detail?.currency_code || 'USD'
    const inv = {
      id, status: 'DRAFT',
      detail: { ...body.detail, currency_code: cur, invoice_date: body.detail?.invoice_date || nowIso().slice(0, 10), payment_term: body.detail?.payment_term || { term_type: 'NET_30' } },
      invoicer: { ...body.invoicer, email_address: body.invoicer?.email_address || acct.email },
      primary_recipients: body.primary_recipients || [],
      items: body.items.map((i) => ({ ...i, unit_of_measure: i.unit_of_measure || 'QUANTITY' })),
      amount: { currency_code: cur, value: fromCents(t.total), breakdown: { item_total: { currency_code: cur, value: fromCents(t.itemTotal) }, discount: { item_discount: { currency_code: cur, value: fromCents(t.discount) } } } },
      due_amount: { currency_code: cur, value: fromCents(t.total) },
      payments: { transactions: [] }, refunds: { transactions: [] },
      merchant: acct.key,
    }
    invoices.set(id, inv)
    return { rel: 'self', href: `${cfg.baseUrl}/v2/invoicing/invoices/${id}`, method: 'GET' }
  }

  function getInvoice(acct, id) {
    const inv = invoices.get(id)
    if (!inv || inv.merchant !== acct.key) throw new HttpError(404, 'INVALID_RESOURCE_ID', 'RESOURCE_NOT_FOUND')
    const { merchant, ...rest } = inv
    return JSON.parse(JSON.stringify(rest))
  }

  function sendInvoice(acct, id, body = {}) {
    const inv = invoices.get(id)
    if (!inv || inv.merchant !== acct.key) throw new HttpError(404, 'INVALID_RESOURCE_ID', 'RESOURCE_NOT_FOUND')
    if (inv.status !== 'DRAFT') throw new HttpError(422, 'INVALID_INVOICE_STATUS', 'INVALID_INVOICE_STATUS')
    inv.status = 'SENT'
    return { href: `${cfg.baseUrl}/invoice/${id}`, sent_to_recipient: body.send_to_recipient !== false }
  }

  function deleteInvoice(acct, id) {
    const inv = invoices.get(id)
    if (!inv || inv.merchant !== acct.key) throw new HttpError(404, 'INVALID_RESOURCE_ID', 'RESOURCE_NOT_FOUND')
    if (!['DRAFT', 'SCHEDULED'].includes(inv.status)) throw new HttpError(422, 'INVALID_INVOICE_STATUS: only DRAFT or SCHEDULED invoices can be deleted', 'INVALID_INVOICE_STATUS')
    invoices.delete(id)
    return { success: true, invoice_id: id }
  }

  function recordPayment(acct, id, body) {
    const inv = invoices.get(id)
    if (!inv || inv.merchant !== acct.key) throw new HttpError(404, 'INVALID_RESOURCE_ID', 'RESOURCE_NOT_FOUND')
    if (inv.status === 'DRAFT') throw new HttpError(422, 'INVALID_INVOICE_STATUS: send the invoice before recording a payment', 'INVALID_INVOICE_STATUS')
    if (body.method === 'PAYPAL' && (!body.payment_id || String(body.payment_id).length > 22)) throw new HttpError(422, 'INVALID_PARAMETER_VALUE: payment_id', 'INVALID_PARAMETER_VALUE')
    const cents = body.amount?.value ? toCents(body.amount.value) : toCents(inv.due_amount.value)
    const due = toCents(inv.due_amount.value) - cents
    inv.payments.transactions.push({ payment_id: body.payment_id, method: body.method, amount: { currency_code: 'USD', value: fromCents(cents) }, payment_date: nowIso().slice(0, 10) })
    inv.due_amount.value = fromCents(Math.max(due, 0))
    inv.status = due <= 0 ? 'PAID' : 'PARTIALLY_PAID'
    return { payment_id: body.payment_id }
  }

  function recordRefund(acct, id, body) {
    const inv = invoices.get(id)
    if (!inv || inv.merchant !== acct.key) throw new HttpError(404, 'INVALID_RESOURCE_ID', 'RESOURCE_NOT_FOUND')
    inv.refunds.transactions.push({ method: body.method, amount: body.amount, refund_date: nowIso().slice(0, 10) })
    inv.status = 'REFUNDED'
    return { refund_id: pid() }
  }

  // ---------- Catalog ----------
  function createProduct(acct, body) {
    const id = `PROD-${pid(14)}`
    const p = { id, name: body.name, description: body.description, type: body.type || 'PHYSICAL', category: body.category, create_time: nowIso(), merchant: acct.key }
    products.set(id, p)
    return { id, name: p.name, description: p.description, type: p.type, category: p.category, create_time: p.create_time }
  }
  const listProducts = (acct) => ({ products: [...products.values()].filter((p) => p.merchant === acct.key).map(({ merchant, ...p }) => p), total_items: products.size })
  const showProduct = (acct, id) => {
    const p = products.get(id)
    if (!p) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND')
    const { merchant, ...rest } = p
    return rest
  }

  // ---------- Reporting ----------
  function listTransactions(acct, q = {}) {
    const start = q.start_date ? Date.parse(q.start_date) : 0
    const end = q.end_date ? Date.parse(q.end_date) : Date.now() + 1000
    const now = Date.now()
    const rows = txns.filter((t) => t.account === acct.key && t.visibleAt <= now && t.initiated >= start && t.initiated <= end)
    return { transaction_details: rows.map((t) => t.body), account_number: acct.payerId, start_date: new Date(start).toISOString(), end_date: new Date(end).toISOString(), page: 1, total_items: rows.length, total_pages: 1, last_refreshed_datetime: nowIso() }
  }

  const balances = (acct) => ({ balances: [{ currency: 'USD', primary: true, total_balance: { currency_code: 'USD', value: fromCents(acct.balance) }, available_balance: { currency_code: 'USD', value: fromCents(acct.balance) } }], account_id: acct.payerId })

  // ---------- Test and demo helpers ----------
  function seedTransaction({ account, id, amount, invoiceId, customId, code = 'T0006', ref, at }) {
    const acct = accounts[account]
    if (!acct) throw new HttpError(400, 'unknown account', 'INVALID_REQUEST')
    if (id && txns.some((t) => t.account === account && t.body.transaction_info.transaction_id === id)) return
    recordTxn(acct, { id: id || pid(), code, amount, invoiceId, customId, ref, at: at ? Date.parse(at) : Date.now() })
  }

  return {
    cfg, accounts, vault, orders, captures, refunds, invoices, txns,
    issueToken, accountFor, byClient,
    createSetupToken, approveSetup, createPaymentToken, getPaymentToken,
    createOrder, approveOrder, captureOrder, getOrder, refundCapture, settlePendingRefunds,
    nextInvoiceNumber, createInvoice, getInvoice, sendInvoice, deleteInvoice, recordPayment, recordRefund,
    createProduct, listProducts, showProduct, listTransactions, balances, seedTransaction,
  }
}
