import { z } from 'zod'
import { HttpError, parse } from '../shared/http.js'

const MOCK_WEBHOOK_ID = 'MOCK-WEBHOOK-ID'

const eventSchema = z.object({
  id: z.string().min(1).max(80),
  event_type: z.string().min(1).max(80),
  resource: z.object({
    id: z.string().max(80).optional(),
    invoice: z.object({ id: z.string().max(80).optional(), status: z.string().max(40).optional() }).passthrough().optional(),
  }).passthrough().default({}),
}).passthrough()

// PayPal tells the supplier that an invoice is paid (INVOICING.INVOICE.PAID). Three rules:
// the signature is checked with PayPal first, the event body is never trusted for the state (the invoice is read back),
// and the same event id twice changes nothing.
export async function handleWebhook(ctx, headers, body) {
  const { db, config, events, primary } = ctx
  const event = parse(eventSchema, body)
  const webhookId = config.webhookId || (primary.mode === 'mock' ? MOCK_WEBHOOK_ID : '')
  if (!webhookId) throw new HttpError(503, 'Webhook id is not configured (SUPPLIER_PAYPAL_WEBHOOK_ID)', 'webhook_not_configured')
  const valid = await primary.verifyWebhookSignature({ webhookId, headers, event: body })
  if (!valid) throw new HttpError(400, 'Webhook signature check failed', 'webhook_bad_signature')

  if (db.get('webhook_events', event.id)) return { handled: false, reason: 'duplicate' }
  db.put('webhook_events', event.id, { id: event.id, event_type: event.event_type, at: new Date().toISOString() })
  if (event.event_type !== 'INVOICING.INVOICE.PAID') return { handled: false, reason: 'ignored_event_type' }

  const invoiceId = event.resource.invoice?.id || event.resource.id
  const neg = db.list('negotiations', (n) => n.invoice?.invoice_id === invoiceId)[0]
  if (!neg) return { handled: false, reason: 'unknown_invoice' }

  const current = await ctx.paypalFor(neg.rail).getInvoice(invoiceId)
  if (current.status !== 'PAID') return { handled: false, reason: 'invoice_not_paid_at_paypal' }
  if (neg.charge?.invoice_status === 'PAID') return { handled: true, reason: 'already_recorded', quote_id: neg.quote_id }

  db.tx(() => {
    db.put('negotiations', neg.quote_id, { ...neg, charge: { ...neg.charge, invoice_status: 'PAID', paid_confirmed_by: 'webhook' } })
    for (const c of db.list('cosigns', (x) => x.quote_id === neg.quote_id && x.state === 'CHARGED')) db.put('cosigns', c.nonce, { ...c, state: 'PAID' })
  })
  events.emit('invoice_paid_webhook', { quote_id: neg.quote_id, invoice_number: neg.invoice.invoice_number, invoice_status: 'PAID' })
  return { handled: true, reason: 'recorded', quote_id: neg.quote_id }
}
