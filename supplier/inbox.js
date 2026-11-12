import { HttpError, parse } from '../shared/http.js'
import { peekJws, sha256b64u, verifyJws } from '../shared/jws.js'
import { MSG, cosignClaims, counterBody, healthBody, quoteHash, refundSyncBody, rfqBody } from '../shared/protocol.js'
import { z } from 'zod'
import { getItem } from './catalog.js'
import { startNegotiation, getNegotiation, latestQuote, cancelNegotiation } from './quotes.js'
import { produceQuote } from './agent/policy.js'
import { handleAccept, handleCosign, handleDraftReject } from './settle.js'
import { startVaultSetup, vaultFor } from './vault.js'
import { healthCheck } from './refunds.js'

const registerBody = z.object({ public_jwk: z.object({ kty: z.string(), crv: z.string(), x: z.string() }), company: z.string(), billing_email: z.string().email() })

// First contact: the buyer introduces its public key in a message signed with that same key.
// The supplier pins the key for that buyer id; a different key later is refused.
export function registerBuyer(ctx, jws) {
  const claimed = peekJws(jws)
  if (claimed.type !== MSG.REGISTER) return false
  const body = registerBody.parse(claimed.body)
  try {
    verifyJws(jws, body.public_jwk)
  } catch {
    throw new HttpError(401, 'Registration is not signed by the key it presents', 'bad_signature')
  }
  const known = ctx.db.get('buyers', claimed.from)
  if (known && known.public_jwk.x !== body.public_jwk.x) throw new HttpError(409, 'A different key is already pinned for this buyer', 'key_conflict')
  ctx.db.put('buyers', claimed.from, { buyer_id: claimed.from, public_jwk: body.public_jwk, company: body.company, billing_email: body.billing_email, registered_at: known?.registered_at || new Date().toISOString() })
  ctx.events.emit('buyer_registered', { buyer_id: claimed.from, company: body.company })
  return true
}

function quoteEvent(ctx, quote, decidedBy) {
  ctx.events.emit('quote_issued', {
    quote_id: quote.quote_id, version: quote.version, decided_by: decidedBy,
    options: quote.options.map((o) => ({ label: o.label, sku: o.sku, qty: o.qty, unit_cents: o.unit_cents, concession_bps: o.concession_bps, pay_now: o.pay_now, total_cents: o.total_cents, terms: o.terms, score_cents: (o.net_unit_cents - getItem(ctx.db, o.sku).cost_cents) * o.qty, substitute_for: o.substitute_for })),
  })
}

async function handleRfq(ctx, msg) {
  const body = parse(rfqBody, msg.body)
  if (!getItem(ctx.db, body.sku)) throw new HttpError(404, `Unknown sku ${body.sku}`, 'unknown_sku')
  const neg = startNegotiation(ctx.db, { buyerId: msg.from, taskId: msg.task_id, request: { sku: body.sku, qty: body.qty, need_by: body.need_by, note: body.note }, clientKey: body.client_key, mode: body.mode })
  ctx.events.emit('rfq', { quote_id: neg.quote_id, sku: body.sku, qty: body.qty, need_by: body.need_by, mode: body.mode })
  try {
    const out = await produceQuote(ctx, neg, { kind: 'rfq', request: neg.request, mode: body.mode })
    quoteEvent(ctx, out.quote, out.decided_by)
    return { type: MSG.QUOTE, body: { quote: out.quote, quote_hash: quoteHash(out.quote), decided_by: out.decided_by } }
  } catch (err) {
    cancelNegotiation(ctx.db, neg.quote_id, 'failed')
    throw err
  }
}

async function handleCounter(ctx, msg) {
  const body = parse(counterBody, msg.body)
  const neg = getNegotiation(ctx.db, body.quote_id)
  if (neg.buyer_id !== msg.from) throw new HttpError(403, 'Not your quote', 'forbidden')
  if (neg.status !== 'open') throw new HttpError(409, `Quote ${neg.quote_id} is ${neg.status}`, 'quote_closed')
  if (neg.round >= ctx.config.maxRounds) throw new HttpError(409, 'No more rounds', 'max_rounds')
  const option = latestQuote(neg).options.find((o) => o.option_id === body.option_id)
  if (!option) throw new HttpError(404, 'Unknown option', 'unknown_option')
  ctx.events.emit('counter', { quote_id: neg.quote_id, option_id: option.option_id, levers: body.levers })
  const out = await produceQuote(ctx, neg, { kind: 'counter', request: neg.request, option, levers: body.levers, note: body.note, mode: neg.mode })
  quoteEvent(ctx, out.quote, out.decided_by)
  return { type: MSG.QUOTE, body: { quote: out.quote, quote_hash: quoteHash(out.quote), decided_by: out.decided_by } }
}

// HEALTH_CHECK: the buyer agent co-signs the one-dollar check of the saved PayPal. The supplier verifies that signature
// like any other co-signature before it charges, and a co-signature works once.
async function handleHealthCheck(ctx, msg) {
  const { cosign_jws } = parse(healthBody, msg.body)
  let claims
  try {
    claims = cosignClaims.parse(verifyJws(cosign_jws, ctx.buyerKey(msg.from)))
  } catch {
    throw new HttpError(403, 'Co-signature check failed', 'cosign_bad_signature')
  }
  if (claims.exp * 1000 < Date.now()) throw new HttpError(403, 'Co-signature expired', 'cosign_expired')
  if (claims.payee !== ctx.config.supplierId || claims.amount !== '1.00' || !/^HEALTH-\d{4}-\d{2}-\d{2}$/.test(claims.invoice_number)) throw new HttpError(403, 'Not a co-signature for the daily check', 'cosign_invoice_mismatch')
  const used = ctx.db.tx(() => {
    if (ctx.db.get('cosigns', claims.nonce)) return true
    ctx.db.put('cosigns', claims.nonce, { nonce: claims.nonce, quote_id: claims.quote_id, state: 'HEALTH', cosign_hash: sha256b64u(cosign_jws) })
    return false
  })
  if (used) throw new HttpError(409, 'Co-signature already used', 'cosign_reused')
  const result = await healthCheck({ db: ctx.db, paypalFor: ctx.paypalFor, vault: vaultFor(ctx.db, msg.from), events: ctx.events, cosign: { hash: sha256b64u(cosign_jws), invoiceId: claims.invoice_number } })
  return { type: MSG.ACK, body: result }
}

// REFUND_SYNC: which of this buyer's quotes were refunded (judge-account sales). The buyer gives the money back to its budget.
function handleRefundSync(ctx, msg) {
  const { quote_ids } = parse(refundSyncBody, msg.body)
  const refunds = quote_ids.flatMap((id) => {
    const neg = ctx.db.get('negotiations', id)
    if (!neg || neg.buyer_id !== msg.from) return []
    const charge = ctx.db.list('charges', (c) => c.quote_id === id)[0]
    return [{ quote_id: id, refunded: Boolean(charge?.refunded), amount_cents: charge?.amount_cents || 0 }]
  })
  return { type: MSG.ACK, body: { refunds } }
}

export async function dispatch(ctx, msg) {
  switch (msg.type) {
    case MSG.RFQ: return handleRfq(ctx, msg)
    case MSG.COUNTER: return handleCounter(ctx, msg)
    case MSG.ACCEPT: return handleAccept(ctx, msg)
    case MSG.DRAFT_REJECT: return handleDraftReject(ctx, msg)
    case MSG.HEALTH_CHECK: return handleHealthCheck(ctx, msg)
    case MSG.REFUND_SYNC: return handleRefundSync(ctx, msg)
    case MSG.COSIGN: return handleCosign(ctx, msg)
    case MSG.VAULT_SETUP: {
      const out = await startVaultSetup({ db: ctx.db, config: ctx.config, paypal: ctx.primary, buyerId: msg.from })
      return { type: MSG.ACK, body: out }
    }
    case MSG.VAULT_STATUS: {
      const vault = vaultFor(ctx.db, msg.from)
      return { type: MSG.ACK, body: { connected: Boolean(vault), account_kind: vault?.account_kind || null, payer_email: vault?.payer_email || null, rail: vault?.rail || null, limits: ctx.limits.status(msg.body?.client_key || 'anonymous'), paypal_mode: ctx.primary.mode } }
    }
    default: throw new HttpError(400, `Supplier does not handle ${msg.type}`, 'unexpected_type')
  }
}
