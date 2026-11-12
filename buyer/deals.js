import { randomUUID } from 'node:crypto'
import { HttpError } from '../shared/http.js'
import { randomId } from '../shared/jws.js'
import { lineItemFor } from '../shared/mandate.js'
import { fmt, pctChange } from '../shared/money.js'
import { MSG, counterBody, quoteHash, quoteSchema } from '../shared/protocol.js'
import { acceptGuard, evaluateQuote } from './evaluate.js'
import { budgetState, commitBudget, getMandate, releaseBudget, reserveBudget, restoreSpent } from './mandates.js'
import { createCosign } from './cosign.js'
import { verifyDraft } from './verifyDraft.js'

const HARD = new Set(['over_budget', 'mandate_expired', 'sku_not_allowed', 'over_charge_limit'])

export function createDealsApi(ctx) {
  const { db, config, supplier, events } = ctx
  const supplierId = () => ctx.supplierId()
  // Every exchange with the supplier is a signed request and a signed reply; the page shows the count next to the settlement.
  const send = (deal, ...args) => { deal.signed_messages = (deal.signed_messages || 0) + 2; return supplier.send(...args) }
  const mandateOf = (deal) => getMandate(db, deal.mandate_id).mandate
  const save = (deal, kind, extra = {}) => {
    db.put('deals', deal.deal_id, deal)
    events.emit(kind || 'deal_update', { deal_id: deal.deal_id, status: deal.status, quote_id: deal.quote_id, ...extra })
    return deal
  }
  const latest = (deal) => deal.rounds.at(-1)?.quote
  const remaining = (deal) => budgetState(db, mandateOf(deal), deal.client_key).remaining_cents

  function startDeal({ mandateId, request, mode, clientKey, networkKey, requestText = null }) {
    const stored = getMandate(db, mandateId)
    if (stored.visitor && stored.visitor !== clientKey) throw new HttpError(404, `Unknown mandate ${mandateId}`, 'unknown_mandate')
    const deal = {
      deal_id: `D-${randomUUID().slice(0, 8)}`, task_id: `task-${randomId(6)}`, mandate_id: mandateId, request, mode, client_key: clientKey, network_key: networkKey, request_text: requestText,
      status: 'negotiating', rounds: [], quote_id: null, accepted: null, draft: null, baseline_total_cents: null, round1_accept_total_cents: null,
      cosign_hash: null, charged: null, approval_id: null, decided_by: 'policy', started_at: new Date().toISOString(), log: [],
    }
    return save(deal, 'deal_started', { mandate_id: mandateId, request, mode })
  }

  function receiveQuote(deal, body, { counterOf = null } = {}) {
    const quote = quoteSchema.parse(body.quote)
    if (quote.supplier_id !== supplierId() || quote.buyer_id !== config.buyerId) throw new HttpError(502, 'Quote is not addressed from the pinned supplier to this buyer', 'bad_quote')
    if (quoteHash(quote) !== body.quote_hash) throw new HttpError(502, 'Quote hash does not match its content', 'bad_quote')
    if (deal.quote_id && quote.quote_id !== deal.quote_id) throw new HttpError(502, 'Quote id changed mid-negotiation', 'bad_quote')
    deal.quote_id = quote.quote_id
    const mandate = mandateOf(deal)
    if (deal.baseline_total_cents === null) {
      const base = quote.options.find((o) => o.sku === deal.request.sku && o.qty === deal.request.qty) || quote.options[0]
      deal.baseline_total_cents = base.total_cents
    }
    const evaluation = evaluateQuote({ mandate, request: deal.request, quote, remainingBudgetCents: remaining(deal), baselineTotalCents: deal.baseline_total_cents })
    deal.rounds.push({ round: quote.version, quote, quote_hash: body.quote_hash, decided_by: body.decided_by, evaluation, counter_of: counterOf })
    if (body.decided_by === 'claude') deal.decided_by = 'claude'
    save(deal, 'quote_received', { round: quote.version, decided_by: body.decided_by, quote, evaluation })
    return { quote, quote_hash: body.quote_hash, evaluation }
  }

  // Free-form request (Claude mode): the model reads the sentence and passes sku and qty to send_rfq. Code checks them against
  // the catalog and the mandate and against the sentence itself, so the model cannot ask for something the person did not write.
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 }
  function numbersIn(text) {
    const t = String(text || '').toLowerCase()
    return new Set([...(t.match(/\d+/g) || []).map(Number), ...t.split(/[^a-z]+/).filter((w) => WORDS[w]).map((w) => WORDS[w])])
  }
  function adoptRequest(deal, { sku, qty, need_by }) {
    if (!deal.request_text || deal.request_adopted) return
    if (!numbersIn(deal.request_text).has(qty)) throw new HttpError(400, `The request text does not ask for ${qty} cases. Use the quantity the person wrote.`, 'qty_not_in_request')
    deal.request = { sku, qty, need_by: need_by || deal.request.need_by }
    deal.request_adopted = true
  }

  async function sendRfq(deal, { sku, qty, need_by, note }) {
    const mandate = mandateOf(deal)
    if (Date.parse(mandate.expires_at) < Date.now()) throw new HttpError(403, 'The mandate has expired', 'mandate_expired')
    if (!lineItemFor(mandate, sku)) throw new HttpError(403, `${sku} is not allowed by the mandate`, 'sku_not_allowed')
    adoptRequest(deal, { sku, qty, need_by })
    events.emit('rfq_sent', { deal_id: deal.deal_id, sku, qty, need_by })
    const reply = await send(deal, MSG.RFQ, deal.task_id, { sku, qty, need_by, note, mode: deal.mode, client_key: deal.client_key }, supplierId())
    if (reply.type !== MSG.QUOTE) throw new HttpError(502, `Expected QUOTE, got ${reply.type}`, 'unexpected_type')
    return receiveQuote(deal, reply.body)
  }

  async function counter(deal, args) {
    const mandate = mandateOf(deal)
    const quote = latest(deal)
    if (!quote) throw new HttpError(409, 'No quote to counter', 'no_quote')
    if (deal.status !== 'negotiating') throw new HttpError(409, `Deal is ${deal.status}`, 'deal_closed')
    if (quote.version >= Math.min(mandate.negotiation.max_rounds, 4)) throw new HttpError(409, 'No rounds left', 'max_rounds')
    const option = quote.options.find((o) => o.option_id === args.option_id)
    if (!option) throw new HttpError(404, 'Unknown option', 'unknown_option')
    const body = counterBody.parse({ quote_id: quote.quote_id, option_id: option.option_id, levers: { pay_now: Boolean(args.pay_now), ask_lower_price: Boolean(args.ask_lower_price) }, note: args.note })
    if (deal.round1_accept_total_cents === null) {
      deal.round1_accept_total_cents = option.total_cents
      // "Saved vs round 1" is only honest when the buyer could have accepted that round-1 option without asking anyone.
      deal.round1_acceptable = acceptGuard({ mandate, request: deal.request, option, remainingBudgetCents: remaining(deal), baselineTotalCents: deal.baseline_total_cents, expired: false }).ok
    }
    save(deal, 'counter_sent', { option_id: option.option_id, levers: body.levers })
    const reply = await send(deal, MSG.COUNTER, deal.task_id, body, supplierId())
    if (reply.type !== MSG.QUOTE) throw new HttpError(502, `Expected QUOTE, got ${reply.type}`, 'unexpected_type')
    return receiveQuote(deal, reply.body, { counterOf: option.option_id })
  }

  function addApproval(deal, optionId, reasons, summary) {
    const approval = { id: `AP-${randomId(4)}`, deal_id: deal.deal_id, kind: 'accept', client_key: deal.client_key, option_id: optionId, reasons, summary, status: 'pending', created_at: new Date().toISOString() }
    db.put('approvals', approval.id, approval)
    deal.status = 'awaiting_approval'
    deal.approval_id = approval.id
    save(deal, 'approval_card', { approval })
    return approval
  }

  async function acceptQuote(deal, optionId, { approved = false } = {}) {
    const quote = latest(deal)
    const mandate = mandateOf(deal)
    const option = quote?.options.find((o) => o.option_id === optionId)
    if (!option) throw new HttpError(404, 'Unknown option', 'unknown_option')
    if (!['negotiating', 'awaiting_approval'].includes(deal.status)) throw new HttpError(409, `Deal is ${deal.status}`, 'deal_closed')
    const guard = acceptGuard({ mandate, request: deal.request, option, remainingBudgetCents: remaining(deal), baselineTotalCents: deal.baseline_total_cents, expired: Date.parse(mandate.expires_at) < Date.now() })
    if (!guard.ok) {
      const hard = guard.reasons.filter((r) => HARD.has(r.code))
      if (hard.length) throw new HttpError(403, hard.map((r) => r.text).join('; '), hard[0].code)
      if (!approved) {
        const approval = addApproval(deal, optionId, guard.reasons, `${option.qty} x ${option.name}, ${fmt(option.total_cents)}`)
        return { ok: false, needs_approval: true, approval_id: approval.id, reasons: guard.reasons.map((r) => r.text) }
      }
    }
    reserveBudget(db, mandate, deal.deal_id, option.total_cents, deal.client_key)
    try {
      const reply = await send(deal, MSG.ACCEPT, deal.task_id, { quote_id: quote.quote_id, option_id: option.option_id, quote_hash: quoteHash(quote), mandate_jws: getMandate(db, deal.mandate_id).jws, client_key: deal.client_key, network_key: deal.network_key }, supplierId())
      if (reply.type !== MSG.DRAFT_READY) throw new HttpError(502, `Expected DRAFT_READY, got ${reply.type}`, 'unexpected_type')
      const b = reply.body
      deal.accepted = { option_id: option.option_id, option, quote_hash: b.quote_hash, version: quote.version, auto: !approved }
      deal.draft = { invoice_id: b.invoice_id, invoice_number: b.invoice_number, invoice: b.invoice, rail: b.rail, rail_reason: b.rail_reason, verified: false, total_cents: option.total_cents }
      deal.status = 'draft_received'
      if (deal.round1_acceptable && deal.round1_accept_total_cents > option.total_cents) deal.saved_cents = deal.round1_accept_total_cents - option.total_cents
      save(deal, 'accepted', { option, auto: !approved, saved_cents: deal.saved_cents || 0, spend_increase_pct: pctChange(deal.baseline_total_cents, option.total_cents) })
      return { ok: true, draft: { invoice_number: b.invoice_number, total: fmt(option.total_cents), rail: b.rail } }
    } catch (err) {
      releaseBudget(db, deal.mandate_id, deal.deal_id, deal.client_key)
      deal.status = 'failed'
      deal.error = err.message
      save(deal, 'deal_failed', { error: err.message })
      throw err
    }
  }

  async function verifyDeal(deal) {
    if (!deal.draft || deal.status !== 'draft_received') throw new HttpError(409, 'No draft to verify', 'no_draft')
    const { option, version } = deal.accepted
    const quote = deal.rounds.find((r) => r.quote.version === version).quote
    const result = verifyDraft({ invoice: deal.draft.invoice, invoiceNumber: deal.draft.invoice_number, option, quote, supplierName: ctx.supplierName(), buyerEmail: config.billingEmail })
    if (result.ok) {
      deal.draft.verified = true
      save(deal, 'draft_verified', { invoice_number: deal.draft.invoice_number, total_cents: option.total_cents })
      return result
    }
    await send(deal, MSG.DRAFT_REJECT, deal.task_id, { quote_id: deal.quote_id, reason: 'Invoice draft does not match the signed quote', mismatches: result.mismatches.slice(0, 20) }, supplierId())
    releaseBudget(db, deal.mandate_id, deal.deal_id, deal.client_key)
    deal.status = 'blocked'
    deal.draft = { ...deal.draft, verified: false, mismatches: result.mismatches }
    save(deal, 'draft_blocked', { invoice_number: deal.draft.invoice_number, mismatches: result.mismatches, sent: false, charged: false })
    return result
  }

  async function cosignAndCharge(deal) {
    const option = deal.accepted?.option
    if (!option || deal.status !== 'draft_received') throw new HttpError(409, 'Nothing to charge', 'no_draft')
    if (option.terms !== 'DUE_ON_RECEIPT') {
      commitBudget(db, deal.mandate_id, deal.deal_id, deal.client_key)
      deal.status = 'invoiced_net30'
      return save(deal, 'invoiced_net30', { invoice_number: deal.draft.invoice_number, total_cents: option.total_cents })
    }
    let cosign
    try {
      cosign = createCosign({ db, config, signer: ctx.signer, deal, option, invoiceNumber: deal.draft.invoice_number, payeeId: supplierId() })
    } catch (err) {
      // A draft that is not verified yet is the caller's mistake and changes nothing. A pause after an audit alert ends the deal:
      // nothing may stay reserved or open.
      if (err.code !== 'cosign_paused') throw err
      releaseBudget(db, deal.mandate_id, deal.deal_id, deal.client_key)
      try { await send(deal, MSG.DRAFT_REJECT, deal.task_id, { quote_id: deal.quote_id, reason: `Buyer could not co-sign: ${err.message}`.slice(0, 400), mismatches: [] }, supplierId()) } catch { /* the supplier cleans up on its own when the quote expires */ }
      deal.status = 'failed'
      deal.error = err.message
      save(deal, 'deal_failed', { error: err.message })
      throw err
    }
    deal.cosign_hash = cosign.cosign_hash
    deal.status = 'settling'
    save(deal, 'cosigned', { amount: cosign.amount, invoice_number: cosign.invoice_number, expires_at: new Date(cosign.exp * 1000).toISOString(), cosign_hash: cosign.cosign_hash })
    try {
      const reply = await send(deal, MSG.COSIGN, deal.task_id, { quote_id: deal.quote_id, cosign_jws: cosign.jws }, supplierId())
      if (![MSG.PAID, MSG.CHARGED].includes(reply.type)) throw new HttpError(502, `Expected CHARGED, got ${reply.type}`, 'unexpected_type')
      const b = reply.body
      db.put('cosigns', cosign.cosign_hash, { ...cosign, state: 'charged', capture_id: b.capture_id, order_id: b.order_id, rail: b.rail, charged_at: new Date().toISOString() })
      commitBudget(db, deal.mandate_id, deal.deal_id, deal.client_key)
      deal.charged = { ...b, at: new Date().toISOString() }
      deal.status = 'paid'
      save(deal, 'charged', { order_id: b.order_id, capture_id: b.capture_id, invoice_status: b.invoice_status, invoice_method: b.invoice_method, rail: b.rail, judge_refund: b.judge_refund, amount: b.amount })
      return deal
    } catch (err) {
      db.put('cosigns', cosign.cosign_hash, { ...cosign, state: 'failed', error: err.message })
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        releaseBudget(db, deal.mandate_id, deal.deal_id, deal.client_key)
        deal.status = 'failed'
      }
      deal.error = err.message
      save(deal, 'deal_failed', { error: err.message })
      throw err
    }
  }

  // After accept: check the draft, and only a verified draft gets a co-signature.
  async function settle(deal) {
    const check = await verifyDeal(deal)
    if (!check.ok) return deal
    return cosignAndCharge(deal)
  }

  async function resolveApproval(approvalId, decision) {
    const approval = db.get('approvals', approvalId)
    if (!approval || approval.status !== 'pending') throw new HttpError(404, 'No pending approval with that id', 'unknown_approval')
    const deal = db.get('deals', approval.deal_id)
    if (decision === 'reject') {
      db.put('approvals', approvalId, { ...approval, status: 'rejected', decided_at: new Date().toISOString() })
      deal.status = 'rejected'
      return save(deal, 'approval_rejected', { approval_id: approvalId })
    }
    db.put('approvals', approvalId, { ...approval, status: 'approved', decided_at: new Date().toISOString() })
    events.emit('approval_approved', { deal_id: deal.deal_id, approval_id: approvalId })
    await acceptQuote(deal, approval.option_id, { approved: true })
    return settle(deal)
  }

  // Judge-account sales are refunded by the supplier. When it reports a refund, the money returns to this visitor's budget.
  async function syncRefunds(visitor) {
    const open = db.list('deals', (x) => x.client_key === visitor && x.status === 'paid' && x.charged && !x.budget_restored && x.charged.judge_refund)
    if (!open.length) return 0
    const reply = await supplier.send(MSG.REFUND_SYNC, 'refunds', { quote_ids: open.map((x) => x.quote_id) }, supplierId())
    let n = 0
    for (const r of reply.body.refunds) {
      const deal = open.find((x) => x.quote_id === r.quote_id)
      if (!deal || !r.refunded) continue
      restoreSpent(db, deal.mandate_id, deal.accepted.option.total_cents, deal.client_key)
      save({ ...deal, budget_restored: true }, 'budget_restored', { amount_cents: deal.accepted.option.total_cents })
      n += 1
    }
    return n
  }

  return { syncRefunds, startDeal, sendRfq, counter, acceptQuote, verifyDeal, cosignAndCharge, settle, resolveApproval, latest, remaining, save, evaluateLatest: (deal) => deal.rounds.at(-1)?.evaluation }
}
