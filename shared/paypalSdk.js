import { randomBytes } from 'node:crypto'
import {
  PaypalClient, PaypalError,
  CheckoutPaymentIntent, PayPalPaymentTokenUsageType, PayPalPaymentTokenCustomerType, PayPalExperienceUserAction,
  PayPalWalletContextShippingPreference, PaymentInitiator, StoredPaymentSourceUsageType, VaultTokenRequestType, OrderStatus,
  setupTokenResponseSchema, paymentTokenResponseSchema, orderSchema, refundSchema, searchResponseSchema, balancesResponseSchema,
} from 'paypal'
import { HttpError } from './http.js'
import { fromCents } from './money.js'

// The APIMatic-generated PayPal SDK behind the same adapter interface as the REST code in paypal.js.
// Every SDK model is turned back into the REST wire shape with the model's own encode(), so callers do not change.

// The SDK declares one environment (sandbox) and no selector, so the host is bound here, explicitly.
export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const OUTCOME_UNKNOWN_TEXT = 'PayPal did not confirm the result yet. It is being checked, do not pay twice.'

// outcome: 'refused' (provider said no, nothing happened), 'unknown' (it may have acted), 'not_sent' (never left).
export class PaypalCallError extends HttpError {
  constructor(status, message, code, outcome) {
    super(status, message, code)
    this.outcome = outcome
  }
}

const unknownOutcome = (op, cause) => Object.assign(new PaypalCallError(502, OUTCOME_UNKNOWN_TEXT, 'paypal_outcome_unknown', 'unknown'), { cause, op })

export function buildSdkClient({ clientId, clientSecret, baseUrl = SANDBOX_BASE, fetch: fetchImpl, retry = {} }) {
  if (!clientId || !clientSecret) throw new Error('PayPal SDK client needs both a client id and a client secret')
  const host = new URL(baseUrl).hostname
  if (baseUrl !== SANDBOX_BASE && !LOOPBACK.has(host)) throw new Error(`PayPal SDK client refuses host ${host}: only the sandbox or a local mock is allowed`)
  return new PaypalClient({
    serverOptions: { baseUrl },
    oauth2: { clientId, clientSecret },
    // Logging stays off and PAYPAL_CLIENT_LOG cannot switch it on; request bodies are never logged.
    logging: { level: 'off' },
    retry: { timeout: 30000, ...retry },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}

function reasonOf(err) {
  const payload = err.payload
  const body = payload?.body
  if (body && typeof body === 'object') {
    const detail = Array.isArray(body.details) ? body.details[0] : null
    return { text: detail?.description || detail?.issue || body.message || body.name, code: detail?.issue || body.name, debugId: body.debugId }
  }
  if (payload?.rawBody) {
    const text = new TextDecoder().decode(payload.rawBody).slice(0, 200)
    return { text: text || undefined, code: undefined, debugId: err.headers?.get('paypal-debug-id') || undefined }
  }
  return { text: undefined, code: undefined, debugId: undefined }
}

// The one place where the SDK's error family becomes the app's HttpError (typescript-error-handling).
export function translate(err, { op, write, log }) {
  if (err instanceof PaypalCallError) return err
  if (!(err instanceof PaypalError)) throw err
  const note = (extra) => log?.(`[paypal-sdk] ${op} ${err.kind} ${extra || ''}`.trim())
  switch (err.kind) {
    case 'api':
      return fromStatus(err.status, reasonOf(err), { op, write, note })
    case 'decode':
      note(`status ${err.status}`)
      if (err.status >= 200 && err.status < 300) return write ? unknownOutcome(op, err) : new PaypalCallError(502, 'PayPal sent an answer we could not read', 'paypal_unreadable', 'unknown')
      return fromStatus(err.status, { text: undefined }, { op, write, note })
    case 'connection':
    case 'timeout':
      note()
      return write ? unknownOutcome(op, err) : new PaypalCallError(502, 'PayPal could not be reached', 'paypal_unreachable', 'unknown')
    case 'auth':
      note()
      return new PaypalCallError(502, 'PayPal refused our credentials', 'paypal_auth', 'not_sent')
    case 'encode':
      note()
      return new PaypalCallError(500, 'A PayPal request value was invalid', 'paypal_encode', 'not_sent')
    default:
      throw err
  }
}

function fromStatus(status, reason, { op, write, note }) {
  note(`status ${status}${reason.debugId ? ` debug ${reason.debugId}` : ''}`)
  if (status === 401 || status === 403) return new PaypalCallError(502, 'PayPal refused our credentials', 'paypal_credentials', 'refused')
  if (status === 429) return new PaypalCallError(503, 'PayPal is rate limiting us', 'paypal_quota', 'refused')
  if (status >= 400 && status < 500) {
    const issue = reason.code || String(status)
    return new PaypalCallError(status, `PayPal ${op}: ${reason.text || issue}`, issue, 'refused')
  }
  return new PaypalCallError(502, 'PayPal had an error', 'paypal_error', write ? 'unknown' : 'refused')
}

const usd = (cents) => ({ currencyCode: 'USD', value: fromCents(cents) })
const newKey = () => randomBytes(12).toString('hex')

export function createSdkOps({ label, clientId, clientSecret, baseUrl, fetch: fetchImpl, retry, vault = {}, log = console.error }) {
  const client = buildSdkClient({ clientId, clientSecret, baseUrl, fetch: fetchImpl, retry })

  const read = async (op, call) => {
    try {
      return await call()
    } catch (err) {
      throw translate(err, { op, write: false, log })
    }
  }

  // claim (made by the caller) -> SDK call -> guard the answer -> on an unknown outcome re-read with the same reference.
  const write = async (op, send, { guard, reread = send } = {}) => {
    try {
      const value = await send()
      return guard ? guard(value) : value
    } catch (err) {
      const failure = translate(err, { op, write: true, log })
      if (failure.outcome !== 'unknown') throw failure
      try {
        const found = await reread()
        if (found) return guard ? guard(found) : found
      } catch (second) {
        log?.(`[paypal-sdk] ${op} re-read failed: ${second?.kind || second?.name}`)
      }
      throw unknownOutcome(op, err)
    }
  }

  const need = (op, ok) => (value) => {
    if (!ok(value)) throw unknownOutcome(op, new Error(`${op} answer is missing a member we depend on`))
    return value
  }

  const vaultOrderBody = ({ vaultId, amountCents, invoiceId, customId }) => ({
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [{ amount: usd(amountCents), invoiceId, customId }],
    paymentSource: {
      paypal: {
        vaultId,
        ...(vault.storedCredential ? { storedCredential: { paymentInitiator: PaymentInitiator.Merchant, usage: StoredPaymentSourceUsageType.Subsequent } } : {}),
      },
    },
  })

  const ops = {
    createSetupToken: ({ returnUrl, cancelUrl, requestId = newKey() }) => write('createSetupToken', async () => setupTokenResponseSchema.encode(await client.vault.createSetupToken({
      payPalRequestId: requestId,
      body: {
        paymentSource: {
          paypal: {
            usageType: PayPalPaymentTokenUsageType.Merchant,
            customerType: vault.customerType || PayPalPaymentTokenCustomerType.Consumer,
            usagePattern: vault.usagePattern || 'UNSCHEDULED_POSTPAID',
            experienceContext: { returnUrl, cancelUrl },
          },
        },
      },
    })), { guard: need('createSetupToken', (v) => v.id && v.links?.some((l) => l.rel === 'approve' || l.rel === 'payer-action')) }),

    createPaymentToken: (setupTokenId, { requestId = newKey() } = {}) => write('createPaymentToken', async () => paymentTokenResponseSchema.encode(await client.vault.createPaymentToken({
      payPalRequestId: requestId,
      body: { paymentSource: { token: { id: setupTokenId, type: VaultTokenRequestType.SetupToken } } },
    })), { guard: need('createPaymentToken', (v) => v.id) }),

    // Merchant-initiated charge of a saved PayPal. Prefer is raised to representation because callers read the capture from the answer.
    chargeVault: (args) => write('chargeVault', async () => orderSchema.encode(await client.orders.createOrder({
      payPalRequestId: args.requestId || newKey(),
      prefer: 'return=representation',
      body: vaultOrderBody(args),
    })), { guard: need('chargeVault', (v) => v.id) }),

    createHumanOrder: ({ amountCents, invoiceId, returnUrl, cancelUrl, requestId = newKey() }) => write('createHumanOrder', async () => orderSchema.encode(await client.orders.createOrder({
      payPalRequestId: requestId,
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [{ amount: usd(amountCents), invoiceId }],
        paymentSource: { paypal: { experienceContext: { returnUrl, cancelUrl, userAction: PayPalExperienceUserAction.PayNow, shippingPreference: PayPalWalletContextShippingPreference.NoShipping } } },
      },
    })), { guard: need('createHumanOrder', (v) => v.id) }),

    // An unknown outcome is settled by reading the order: a COMPLETED order is the capture; anything else stays unknown.
    captureOrder: (id, { requestId = newKey() } = {}) => write('captureOrder', async () => orderSchema.encode(await client.orders.captureOrder({
      id, payPalRequestId: requestId, prefer: 'return=representation',
      // Without a body the SDK sends no Content-Type and the sandbox answers 415 UNSUPPORTED_MEDIA_TYPE.
      body: {},
    })), {
      guard: need('captureOrder', (v) => v.id && v.status),
      reread: async () => {
        const order = await client.orders.getOrder({ id })
        return order.status === OrderStatus.Completed ? orderSchema.encode(order) : null
      },
    }),

    getOrder: (id) => read('getOrder', async () => {
      const order = orderSchema.encode(await client.orders.getOrder({ id }))
      if (!order.id || !order.status) throw new PaypalCallError(502, 'PayPal sent an answer we could not read', 'paypal_unreadable', 'unknown')
      return order
    }),

    refundCapture: (captureId, cents, invoiceId, { requestId = newKey() } = {}) => write('refundCapture', async () => refundSchema.encode(await client.payments.refundCapturedPayment({
      captureId,
      payPalRequestId: requestId,
      body: { amount: usd(cents), ...(invoiceId ? { invoiceId } : {}), noteToPayer: 'Judge sandbox balance restore' },
    })), { guard: need('refundCapture', (v) => v.id && v.status) }),

    listTransactions: (startIso, endIso) => read('listTransactions', async () => searchResponseSchema.encode(await client.transactionSearch.searchTransactions({ startDate: startIso, endDate: endIso, fields: 'transaction_info', pageSize: 500 }))),

    balance: () => read('balance', async () => {
      const data = balancesResponseSchema.encode(await client.transactionSearch.searchBalances({}))
      const value = Number(data.balances?.[0]?.available_balance?.value ?? data.balances?.[0]?.total_balance?.value)
      if (!Number.isFinite(value)) throw new PaypalCallError(502, 'PayPal sent an answer we could not read', 'paypal_unreadable', 'unknown')
      return Math.round(value * 100)
    }),
  }

  return { label, client, ops }
}
