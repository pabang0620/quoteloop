import { HttpError, parse } from '../shared/http.js'
import { sha256b64u, verifyJws } from '../shared/jws.js'
import { openMandate, lineItemFor } from '../shared/mandate.js'
import { fromCents, toCents } from '../shared/money.js'
import { captureOf } from '../shared/paypal.js'
import { MSG, acceptBody, cosignBody, cosignClaims, draftRejectBody } from '../shared/protocol.js'
import { acceptQuote, cancelNegotiation, getNegotiation, latestQuote } from './quotes.js'
import { createDraft, discardDraft } from './invoices.js'
import { assertKnownVault, vaultFor } from './vault.js'
import { scheduleJudgeRefund } from './refunds.js'

async function simulatedVault(ctx, buyerId) {
  const existing = ctx.db.get('vaults', `sim:${buyerId}`)
  if (existing) return existing
  const mock = ctx.paypalFor('simulated')
  const setup = await mock.createSetupToken({ returnUrl: `${ctx.config.publicUrl}/vault/return`, cancelUrl: ctx.config.buyerUiUrl })
  const res = await fetch(`${mock.base}/mock/auto-approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setup: setup.id, payer: 'judge' }) })
  if (!res.ok) throw new HttpError(502, 'Simulated PayPal is not reachable', 'mock_unreachable')
  const token = await mock.createPaymentToken(setup.id)
  const vault = { vault_id: token.id, buyer_id: buyerId, account_kind: 'judge', rail: 'mock', active: true }
  ctx.db.put('vaults', `sim:${buyerId}`, vault)
  return vault
}

// ACCEPT: check the mandate, win the compare-and-set, pick the rail, draft the invoice (not sent).
export async function handleAccept(ctx, msg) {
  const { db, config, events } = ctx
  const body = parse(acceptBody, msg.body)
  let mandate
  try {
    mandate = openMandate(body.mandate_jws, ctx.buyerKey(msg.from))
  } catch {
    throw new HttpError(403, 'Mandate signature check failed', 'bad_mandate')
  }
  if (mandate.issuer.buyer_id !== msg.from) throw new HttpError(403, 'Mandate belongs to another buyer', 'bad_mandate')
  if (Date.parse(mandate.expires_at) < Date.now()) throw new HttpError(403, 'Mandate expired', 'mandate_expired')
  if (!mandate.checkout.allowed_merchants.includes(config.supplierId) || !mandate.payment.allowed_payees.includes(config.supplierId)) {
    throw new HttpError(403, 'This supplier is not allowed by the mandate', 'merchant_not_allowed')
  }
  const neg = getNegotiation(db, body.quote_id)
  const quote = latestQuote(neg)
  const option = quote.options.find((o) => o.option_id === body.option_id)
  if (!option) throw new HttpError(404, 'Unknown option', 'unknown_option')
  if (!lineItemFor(mandate, option.sku)) throw new HttpError(403, `SKU ${option.sku} is outside the mandate`, 'sku_not_allowed')
  const maxCharge = Math.min(mandate.payment.amount_range.max_cents, config.perChargeLimitCents)
  if (option.total_cents > maxCharge) throw new HttpError(403, 'Amount is above the per-charge limit', 'over_limit')
  const buyer = db.get('buyers', msg.from)
  const baseVault = vaultFor(db, msg.from)
  if (!baseVault) throw new HttpError(409, 'No saved PayPal for this buyer. Connect PayPal first.', 'no_payment_method')

  const accepted = acceptQuote(db, config, { quoteId: body.quote_id, optionId: body.option_id, hash: body.quote_hash })
  try {
    const { rail, reason } = ctx.limits.decideRail({ clientKey: body.client_key, networkKey: body.network_key, paypalMode: ctx.primary.mode, accountKind: baseVault.account_kind, amountCents: option.total_cents })
    const vault = rail === 'simulated' ? await simulatedVault(ctx, msg.from) : baseVault
    if (reason === 'low_balance') {
      events.emit('operator_alert', { message: 'Judge sandbox balance is under the minimum. New live charges are paused. Top up the judge account or replace it.' })
      console.error('[supplier] judge sandbox balance low: live charges paused')
    }
    const paypal = ctx.paypalFor(rail)
    db.put('negotiations', accepted.quote_id, { ...accepted, rail, rail_reason: reason, vault_id: vault.vault_id, account_kind: vault.account_kind, client_key: body.client_key, mandate_id: mandate.mandate_id })
    const tamper = ctx.demo.misbehaveFor.delete(body.client_key)
    const draft = await createDraft({ db, config, paypal, tamper, neg: db.get('negotiations', accepted.quote_id), buyer: { company: mandate.issuer.company, email: buyer?.billing_email || 'ap@brightcup.example' } })
    events.emit('draft_created', { quote_id: accepted.quote_id, invoice_number: draft.invoice_number, rail, total: option.total_cents })
    return { type: MSG.DRAFT_READY, body: { quote_id: accepted.quote_id, option_id: option.option_id, quote_hash: body.quote_hash, invoice_id: draft.invoice_id, invoice_number: draft.invoice_number, invoice: draft.invoice, rail, rail_reason: reason } }
  } catch (err) {
    cancelNegotiation(db, accepted.quote_id, 'failed')
    throw err
  }
}

// DRAFT_REJECT: the buyer's check failed, so the draft is deleted and nothing is sent or charged.
export async function handleDraftReject(ctx, msg) {
  const body = parse(draftRejectBody, msg.body)
  const neg = getNegotiation(ctx.db, body.quote_id)
  const result = await discardDraft({ db: ctx.db, paypal: ctx.paypalFor(neg.rail), neg })
  cancelNegotiation(ctx.db, body.quote_id, 'draft_rejected')
  ctx.events.emit('draft_rejected', { quote_id: body.quote_id, reason: body.reason, mismatches: body.mismatches, deleted: result.deleted })
  return { type: MSG.ACK, body: { quote_id: body.quote_id, deleted: result.deleted, charged: false, sent: false } }
}

function verifyCosign(ctx, msg, neg, cosignJws) {
  let claims
  try {
    claims = cosignClaims.parse(verifyJws(cosignJws, ctx.buyerKey(msg.from)))
  } catch {
    throw new HttpError(403, 'Co-signature check failed', 'cosign_bad_signature')
  }
  const draft = neg.invoice
  const option = neg.accepted.option
  if (claims.exp * 1000 < Date.now()) throw new HttpError(403, 'Co-signature expired', 'cosign_expired')
  if (claims.payee !== ctx.config.supplierId) throw new HttpError(403, 'Co-signature is for another payee', 'cosign_payee_mismatch')
  if (claims.quote_id !== neg.quote_id || claims.quote_hash !== neg.accepted.quote_hash) throw new HttpError(403, 'Co-signature is for another quote', 'cosign_quote_mismatch')
  if (claims.invoice_number !== draft.invoice_number) throw new HttpError(403, 'Co-signature is for another invoice', 'cosign_invoice_mismatch')
  if (toCents(claims.amount) !== option.total_cents || claims.amount !== draft.invoice.amount.value) throw new HttpError(403, 'Co-signature amount does not match the invoice', 'cosign_amount_mismatch')
  if (option.total_cents > ctx.config.perChargeLimitCents) throw new HttpError(403, 'Above the per-charge limit', 'over_limit')
  return claims
}

// COSIGN: verify, send the invoice, charge the saved PayPal, confirm the order, record the payment.
export async function handleCosign(ctx, msg) {
  const { db, config, events } = ctx
  const body = parse(cosignBody, msg.body)
  const neg = getNegotiation(db, body.quote_id)
  if (!neg.invoice || neg.status !== 'accepted') throw new HttpError(409, `Quote is ${neg.status}, nothing to charge`, 'no_draft')
  if (neg.accepted.option.terms !== 'DUE_ON_RECEIPT') throw new HttpError(409, 'This quote is on NET_30 terms: it is invoiced, not charged', 'terms_not_chargeable')
  const claims = verifyCosign(ctx, msg, neg, body.cosign_jws)
  const cosignHash = sha256b64u(body.cosign_jws)

  // The vault id must be one this supplier saved. Checked before the claim, so a refused value leaves no claim behind.
  assertKnownVault(db, neg.vault_id)

  // The claim: one charge per co-signature, one co-signature per quote. A retry of an unfinished charge reuses its
  // nonce (and so the same PayPal-Request-Id), but only one call at a time may be in flight.
  db.tx(() => {
    const used = db.get('cosigns', claims.nonce)
    if (used && used.state !== 'CHARGING') throw new HttpError(409, 'Co-signature already used', 'cosign_reused')
    if (used?.in_flight) throw new HttpError(409, 'This charge is already running', 'charge_in_flight')
    const other = db.list('cosigns', (c) => c.quote_id === neg.quote_id && c.nonce !== claims.nonce && c.state !== 'FAILED')
    if (other.length) throw new HttpError(409, 'This quote already has a charge', 'already_charged')
    db.put('cosigns', claims.nonce, { nonce: claims.nonce, quote_id: neg.quote_id, state: 'CHARGING', in_flight: true, cosign_hash: cosignHash })
  })

  const paypal = ctx.paypalFor(neg.rail)
  const option = neg.accepted.option
  try {
    if (!neg.invoice.sent) {
      await paypal.sendInvoice(neg.invoice.invoice_id)
      db.put('negotiations', neg.quote_id, { ...db.get('negotiations', neg.quote_id), invoice: { ...neg.invoice, sent: true } })
    }
    const order = await paypal.chargeVault({ vaultId: neg.vault_id, amountCents: option.total_cents, invoiceId: neg.invoice.invoice_number, customId: cosignHash, requestId: claims.nonce })
    const check = await paypal.getOrder(order.id)
    const capture = captureOf(check)
    if (check.status !== 'COMPLETED' || !capture || toCents(capture.amount.value) !== option.total_cents) {
      throw new HttpError(502, `Order ${order.id} is ${check.status}, not a completed capture of ${fromCents(option.total_cents)}`, 'charge_not_confirmed')
    }
    db.put('cosigns', claims.nonce, { nonce: claims.nonce, quote_id: neg.quote_id, state: 'CHARGED', cosign_hash: cosignHash, order_id: order.id, capture_id: capture.id })
    events.emit('charged', { quote_id: neg.quote_id, order_id: order.id, capture_id: capture.id, amount_cents: option.total_cents, rail: neg.rail })

    let invoiceStatus = 'PAID'
    let invoiceMethod = 'PAYPAL'
    try {
      await paypal.recordPayment(neg.invoice.invoice_id, capture.id, option.total_cents)
    } catch {
      invoiceMethod = 'OTHER'
      try {
        await paypal.recordPaymentOther(neg.invoice.invoice_id, option.total_cents, `PayPal capture ${capture.id}`)
      } catch {
        invoiceStatus = 'record_failed'
      }
    }
    const charge = { quote_id: neg.quote_id, order_id: order.id, capture_id: capture.id, amount_cents: option.total_cents, vault_id: neg.vault_id, account_kind: neg.account_kind, rail: neg.rail, custom_id: cosignHash, invoice_id: neg.invoice.invoice_number, invoice_ref: neg.invoice.invoice_id, client_key: neg.client_key, at: new Date().toISOString(), refunded: false }
    db.tx(() => {
      db.put('charges', capture.id, charge)
      db.put('cosigns', claims.nonce, { nonce: claims.nonce, quote_id: neg.quote_id, state: invoiceStatus === 'PAID' ? 'PAID' : 'CHARGED', cosign_hash: cosignHash, order_id: order.id, capture_id: capture.id })
      // A sale to the shared judge account is refunded minutes later, so it must not use up the stock the next visitor sees.
      if (neg.account_kind !== 'judge') {
        const item = db.get('catalog', option.sku)
        db.put('catalog', option.sku, { ...item, stock: item.stock - option.qty })
      }
      db.del('reservations', neg.quote_id)
      db.put('negotiations', neg.quote_id, { ...db.get('negotiations', neg.quote_id), status: 'paid', charge: { order_id: order.id, capture_id: capture.id, invoice_status: invoiceStatus } })
    })
    if (neg.rail === 'live' && neg.account_kind === 'judge') ctx.limits.adjustBalance(-option.total_cents)
    const refundJob = neg.account_kind === 'judge' ? scheduleJudgeRefund({ db, config, charge }) : null
    events.emit('paid', { quote_id: neg.quote_id, invoice_number: neg.invoice.invoice_number, invoice_status: invoiceStatus, stock_after: db.get('catalog', option.sku).stock, sku: option.sku })
    return { type: invoiceStatus === 'PAID' ? MSG.PAID : MSG.CHARGED, body: { quote_id: neg.quote_id, order_id: order.id, capture_id: capture.id, amount: claims.amount, invoice_number: neg.invoice.invoice_number, invoice_status: invoiceStatus, invoice_method: invoiceMethod, custom_id: cosignHash, rail: neg.rail, judge_refund: neg.account_kind === 'judge', refund_due_at: refundJob ? new Date(refundJob.due_at).toISOString() : null } }
  } catch (err) {
    const definitive = err instanceof HttpError && err.status >= 400 && err.status < 500
    if (definitive) db.put('cosigns', claims.nonce, { nonce: claims.nonce, quote_id: neg.quote_id, state: 'FAILED', cosign_hash: cosignHash, error: err.message })
    else db.put('cosigns', claims.nonce, { nonce: claims.nonce, quote_id: neg.quote_id, state: 'CHARGING', in_flight: false, cosign_hash: cosignHash, error: err.message })
    events.emit('charge_failed', { quote_id: neg.quote_id, error: err.message, retryable: !definitive })
    throw err
  }
}
