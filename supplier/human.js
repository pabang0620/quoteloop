import { HttpError } from '../shared/http.js'
import { fmt } from '../shared/money.js'
import { runClaimed } from '../shared/claims.js'
import { captureOf } from '../shared/paypal.js'
import { getItem } from './catalog.js'
import { createDraft } from './invoices.js'
import { acceptQuote, getNegotiation, latestQuote, startNegotiation } from './quotes.js'
import { policyQuote } from './agent/policy.js'
import { quoteHash } from '../shared/protocol.js'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
// Same Purchase Order Ledger look as the buyer's desk (web/src/styles.css): paper, serif heading, mono figures, double-ruled total.
const FONTS = 'https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap'
const shell = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="${FONTS}">
<style>:root{color-scheme:light}body{font:15px/1.45 'IBM Plex Sans',system-ui,sans-serif;margin:0;background:#efeae0;color:#1d1a16;-webkit-font-smoothing:antialiased}
main{position:relative;max-width:520px;margin:40px auto;background:#fbf8f2;padding:32px 40px;box-shadow:0 2px 0 rgba(29,26,22,.06),0 18px 40px rgba(29,26,22,.10)}
main::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:repeating-linear-gradient(90deg,#1f3a5f 0 18px,transparent 18px 24px)}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:#6b6358}h2{font:600 26px/1.2 'Source Serif 4',Georgia,serif;margin:4px 0 14px}
table{width:100%;border-collapse:collapse;margin:12px 0 18px;font-size:14px;border-top:1px solid #1d1a16}td{padding:8px 0;border-bottom:1px solid #d6cdbd}td:last-child{text-align:right;font-family:'IBM Plex Mono',ui-monospace,monospace;white-space:nowrap}
tr.total td{border-top:1px solid #1d1a16;border-bottom:3px double #1d1a16;font-weight:600}tr.total td:last-child{font-size:22px}
button{width:100%;padding:12px;border:1px solid #1f3a5f;border-radius:2px;background:#1f3a5f;color:#fbf8f2;font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #1f3a5f;outline-offset:2px}
small{display:block;margin-top:10px;color:#6b6358;font-size:12px}.stamp{position:absolute;right:28px;top:26px;transform:rotate(-8deg);border:3px solid #2e6b3f;color:#2e6b3f;font:500 15px/1.2 'IBM Plex Mono',monospace;letter-spacing:.12em;padding:4px 12px;border-radius:3px}
@media (max-width:560px){main{margin:16px;padding:28px 18px}h2{font-size:22px}.stamp{right:12px;top:12px;font-size:12px}}</style><main>${body}</main>`

// A person without a buyer agent opens a quote link from the supplier's agent and pays on PayPal.
export function createHumanQuote(ctx, { sku, qty, clientKey }) {
  if (!getItem(ctx.db, sku)) throw new HttpError(404, `Unknown sku ${sku}`, 'unknown_sku')
  const neg = startNegotiation(ctx.db, { buyerId: `human:${clientKey}`, taskId: `human-${Date.now()}`, request: { sku, qty }, clientKey, mode: 'policy' })
  const session = policyHumanQuote(ctx, neg, { sku, qty })
  return { quote_id: neg.quote_id, url: `${ctx.config.publicUrl}/q/${neg.quote_id}`, quote: session }
}

function policyHumanQuote(ctx, neg, request) {
  // Same price engine: round 1 price with the pay-now discount, one option, paid by PayPal right away.
  const out = policyQuote(ctx, { ...neg, round: 0 }, { kind: 'counter', request, option: { sku: request.sku, qty: request.qty, pay_now: true }, levers: { pay_now: true } })
  return out.quote
}

export function quotePage(ctx, quoteId) {
  const neg = getNegotiation(ctx.db, quoteId)
  const o = latestQuote(neg).options[0]
  return shell(`Quote ${quoteId}`, `<div class="eyebrow">Quote by link, from the supplier's sales agent</div><h2>${esc(ctx.config.name)} quote ${esc(quoteId)}</h2>
<table><tr><td>${esc(o.name)}</td><td>${o.qty} x ${fmt(o.unit_cents)}</td></tr>
<tr><td>Pay-now discount</td><td>-${fmt(o.pay_now_discount_cents)}</td></tr><tr class="total"><td>Total</td><td>${fmt(o.total_cents)}</td></tr></table>
<form method="post" action="/q/${esc(quoteId)}/pay"><button>Pay with PayPal (${ctx.primary.mode === 'mock' ? 'bundled mock, no real money' : 'sandbox'})</button></form><small>Quoted by the supplier's sales agent. Status: ${esc(neg.status)}.</small>`)
}

export async function startHumanPayment(ctx, quoteId) {
  const neg = getNegotiation(ctx.db, quoteId)
  const quote = latestQuote(neg)
  const o = quote.options[0]
  const accepted = acceptQuote(ctx.db, ctx.config, { quoteId, optionId: o.option_id, hash: quoteHash(quote) })
  const rail = ctx.primary.mode === 'mock' ? 'mock' : 'live'
  const paypal = ctx.paypalFor(rail)
  ctx.db.put('negotiations', quoteId, { ...accepted, rail })
  const draft = await createDraft({ db: ctx.db, config: ctx.config, paypal, neg: ctx.db.get('negotiations', quoteId), buyer: { company: 'Walk-in buyer', email: 'buyer@example.com' } })
  await paypal.sendInvoice(draft.invoice_id)
  const order = await runClaimed(ctx.db, `order:${quoteId}`, (requestId) => paypal.createHumanOrder({ amountCents: o.total_cents, invoiceId: draft.invoice_number, returnUrl: `${ctx.config.publicUrl}/q/${quoteId}/return`, cancelUrl: `${ctx.config.publicUrl}/q/${quoteId}`, requestId }), { keep: true })
  ctx.db.put('negotiations', quoteId, { ...ctx.db.get('negotiations', quoteId), human_order_id: order.id, invoice: { ...draft, sent: true } })
  const link = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')
  if (!link) throw new HttpError(502, 'PayPal gave no approval link', 'paypal_no_link')
  return link.href
}

export async function finishHumanPayment(ctx, quoteId) {
  const neg = getNegotiation(ctx.db, quoteId)
  const paypal = ctx.paypalFor(neg.rail)
  if (neg.status === 'paid') throw new HttpError(409, 'This quote is already paid', 'already_paid')
  // The capture happens once. If it already happened but recording it failed, read the order instead of capturing again.
  const done = await runClaimed(ctx.db, `capture:${neg.human_order_id}`, (requestId) => paypal.captureOrder(neg.human_order_id, { requestId }), { keep: true })
    .catch((err) => (err?.code === 'claim_done' ? paypal.getOrder(neg.human_order_id) : Promise.reject(err)))
  const capture = captureOf(done)
  if (done.status !== 'COMPLETED' || !capture) throw new HttpError(502, 'PayPal did not complete the payment', 'charge_not_confirmed')
  // The sandbox does not know an Orders capture id as an invoice payment (404), so fall back to an OTHER-method payment with the capture id in the note.
  let invoiceStatus = 'PAID'
  try {
    await paypal.recordPayment(neg.invoice.invoice_id, capture.id, neg.accepted.option.total_cents)
  } catch {
    try {
      await paypal.recordPaymentOther(neg.invoice.invoice_id, neg.accepted.option.total_cents, `PayPal capture ${capture.id}`)
    } catch {
      invoiceStatus = 'record_failed'
    }
  }
  const option = neg.accepted.option
  // A walk-in payer on the demo does not use up the shared stock either: the next visitor must see the same numbers.
  const item = ctx.db.get('catalog', option.sku)
  ctx.db.del('reservations', quoteId)
  ctx.db.put('negotiations', quoteId, { ...ctx.db.get('negotiations', quoteId), status: 'paid', charge: { capture_id: capture.id, order_id: done.id, invoice_status: invoiceStatus } })
  ctx.events.emit('paid', { quote_id: quoteId, invoice_number: neg.invoice.invoice_number, invoice_status: invoiceStatus, human: true, sku: option.sku, stock_after: item.stock })
  return shell('Paid', `<div class="stamp">PAID</div><div class="eyebrow">Receipt, ${esc(ctx.config.name)}</div><h2>Paid</h2><p>Quote ${esc(quoteId)} is paid: ${fmt(option.total_cents)}. Invoice ${esc(neg.invoice.invoice_number)} is marked ${invoiceStatus === 'PAID' ? 'PAID' : 'for review'}.</p><small>PayPal capture ${esc(capture.id)}</small>`)
}

