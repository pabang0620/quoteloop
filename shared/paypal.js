import { randomBytes } from 'node:crypto'
import { HttpError } from './http.js'
import { money } from './money.js'
import { createSdkOps, SANDBOX_BASE } from './paypalSdk.js'

// One PayPal client per service and per account. With credentials it talks to the PayPal sandbox:
// Orders, Vault, refunds and Transaction Search go through the APIMatic PayPal SDK (shared/paypalSdk.js),
// Invoicing and Catalog stay on REST and the PayPal Agent Toolkit (the SDK has no such resource).
// Without credentials it talks to the mock PayPal process with the same REST paths and response shapes,
// so the REST bodies below are the mock adapter for the SDK operations.
// sdkFetch, sdkBase and sdkRetry exist for tests: they let the SDK adapter run against a fake fetch or the local mock.
export function createPaypal({ label, clientId, clientSecret, mockBase, mockClientId, mockClientSecret, forceMock = false, vault = {}, sdkFetch, sdkBase, sdkRetry, log }) {
  const live = Boolean(clientId && clientSecret && !forceMock)
  const base = live ? SANDBOX_BASE : mockBase
  const creds = live ? { id: clientId, secret: clientSecret } : { id: mockClientId, secret: mockClientSecret }
  let token = { value: null, expires: 0 }
  let toolkitPromise = null

  async function accessToken() {
    if (token.value && Date.now() < token.expires - 60000) return token.value
    const basic = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64')
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new HttpError(res.status === 401 ? 401 : 502, `PayPal ${label}: oauth failed (${res.status})`, 'paypal_auth')
    const data = await res.json()
    token = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 }
    return token.value
  }

  async function rest(method, path, body, { requestId } = {}) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }
    if (requestId) headers['PayPal-Request-Id'] = requestId
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    if (!res.ok) {
      const issue = data.details?.[0]?.issue || data.code || data.name || data.message || res.status
      throw new HttpError(res.status, `PayPal ${method} ${path.split('?')[0].split('/').slice(-2).join('/')}: ${issue}`, String(issue))
    }
    return data
  }

  // Agent Toolkit tools: real toolkit when live, the mock process when not.
  async function loadToolkit() {
    if (!toolkitPromise) {
      toolkitPromise = import('@paypal/agent-toolkit/openai').then(({ PayPalAgentToolkit }) => new PayPalAgentToolkit({
        clientId: creds.id,
        clientSecret: creds.secret,
        configuration: {
          actions: {
            invoices: { get: true, send: true, delete: true, generateInvoiceNumber: true, recordPayment: true, recordRefund: true },
            products: { create: true, list: true, show: true },
            transactions: { list: true },
            payments: { createRefund: true },
          },
          context: { sandbox: true },
        },
      }))
    }
    return toolkitPromise
  }

  let callNo = 0
  async function toolkit(name, args = {}) {
    if (!live) return rest('POST', `/mock/toolkit/${name}`, args)
    const kit = await loadToolkit()
    callNo += 1
    const result = await kit.handleToolCall({ id: `call_${callNo}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
    const parsed = JSON.parse(result.content)
    // The sandbox toolkit reports a refused call as {ok:false,status,code,message}, not as {error}.
    if (parsed?.ok === false) throw new HttpError(parsed.status >= 400 && parsed.status < 600 ? parsed.status : 502, `PayPal toolkit ${name}: ${parsed.message || parsed.code}`, 'toolkit_error')
    if (parsed?.error) throw new HttpError(502, `PayPal toolkit ${name}: ${typeof parsed.error === 'string' ? parsed.error : parsed.error.message}`, 'toolkit_error')
    return parsed
  }

  const restOps = {
    // ---- Vault (purchase later, separate from any checkout) ----
    createSetupToken: ({ returnUrl, cancelUrl, requestId }) => rest('POST', '/v3/vault/setup-tokens', {
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          customer_type: vault.customerType || 'CONSUMER',
          usage_pattern: vault.usagePattern || 'UNSCHEDULED_POSTPAID',
          experience_context: { return_url: returnUrl, cancel_url: cancelUrl },
        },
      },
    }, { requestId: requestId || randomBytes(12).toString('hex') }),
    createPaymentToken: (setupTokenId, { requestId } = {}) => rest('POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } }, { requestId: requestId || randomBytes(12).toString('hex') }),

    // ---- Orders ----
    chargeVault: ({ vaultId, amountCents, invoiceId, customId, requestId }) => rest('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ amount: money(amountCents), invoice_id: invoiceId, custom_id: customId }],
      payment_source: { paypal: { vault_id: vaultId, ...(vault.storedCredential ? { stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT' } } : {}) } },
    }, { requestId }),
    createHumanOrder: ({ amountCents, invoiceId, returnUrl, cancelUrl, requestId }) => rest('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ amount: money(amountCents), invoice_id: invoiceId }],
      payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
    }, { requestId: requestId || randomBytes(12).toString('hex') }),
    captureOrder: (id, { requestId } = {}) => rest('POST', `/v2/checkout/orders/${id}/capture`, {}, { requestId: requestId || randomBytes(12).toString('hex') }),
    getOrder: (id) => rest('GET', `/v2/checkout/orders/${id}`),

    // ---- Invoicing: draft by REST (payment_term and item discounts), the rest through the toolkit ----
    createInvoiceDraft: (body) => rest('POST', '/v2/invoicing/invoices', body),
    // The sandbox toolkit already returns a prefixed number (INV-...); the invoice number limit is 25 characters.
    generateInvoiceNumber: async () => { const n = String((await toolkit('generate_invoice_number', {})).invoice_number); return n.startsWith('INV-') ? n : `INV-${n}` },
    getInvoice: (id) => toolkit('get_invoice', { invoice_id: id }),
    sendInvoice: (id) => toolkit('send_invoice', { invoice_id: id, send_to_recipient: false }),
    deleteInvoice: (id) => toolkit('delete_invoice', { invoice_id: id }),
    recordPayment: (id, captureId, cents) => toolkit('record_payment_for_invoice', { invoice_id: id, method: 'PAYPAL', payment_id: captureId, amount: money(cents) }),
    recordPaymentOther: (id, cents, note) => toolkit('record_payment_for_invoice', { invoice_id: id, method: 'OTHER', note, amount: money(cents) }),
    refundCapture: (captureId, cents, invoiceId) => toolkit('create_refund', { capture_id: captureId, amount: money(cents), invoice_id: invoiceId, note_to_payer: 'Judge sandbox balance restore' }),
    recordRefund: (id, cents) => toolkit('record_refund_for_invoice', { invoice_id: id, method: 'PAYPAL', amount: money(cents) }),

    // ---- Webhooks: PayPal checks the signature of an event it sent (REST, the SDK map has no resource for it) ----
    verifyWebhookSignature: async ({ webhookId, headers, event }) => {
      const out = await rest('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: webhookId, webhook_event: event,
      })
      return out.verification_status === 'SUCCESS'
    },

    // ---- Catalog and reporting ----
    createProduct: (p) => toolkit('create_product', p),
    listTransactions: (startIso, endIso) => toolkit('list_transactions', { start_date: startIso, end_date: endIso }),
    balance: async () => {
      const data = await rest('GET', '/v1/reporting/balances')
      return Math.round(Number(data.balances?.[0]?.available_balance?.value ?? data.balances?.[0]?.total_balance?.value) * 100)
    },
  }

  // Live: the SDK owns every operation it covers. Mock: the REST bodies above, unchanged.
  const sdk = live ? createSdkOps({ label, clientId, clientSecret, baseUrl: sdkBase, fetch: sdkFetch, retry: sdkRetry, vault, log }) : null
  return {
    label,
    mode: live ? 'sandbox' : 'mock',
    base,
    rest,
    toolkit,
    ...restOps,
    ...(sdk ? sdk.ops : {}),
  }
}

export const captureOf = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0] || null

export function invoiceBody({ invoiceNumber, po, termType, supplier, buyer, lines }) {
  return {
    detail: { invoice_number: invoiceNumber, reference: po, currency_code: 'USD', payment_term: { term_type: termType }, note: 'QuoteLoop agent-to-agent quote' },
    // No invoicer email: send_invoice on the sandbox refuses an email that is not the REST app's own account email.
    invoicer: { name: { business_name: supplier.name } },
    primary_recipients: [{ billing_info: { name: { business_name: buyer.name }, email_address: buyer.email } }],
    items: lines.map((l) => ({
      name: l.name,
      quantity: String(l.qty),
      unit_amount: money(l.unit_cents),
      ...(l.discount_cents ? { discount: { amount: money(l.discount_cents) } } : {}),
    })),
    configuration: { allow_tip: false, tax_inclusive: false },
  }
}

