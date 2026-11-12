import { fmt, pctChange } from '../shared/money.js'
import { lineItemFor } from '../shared/mandate.js'

// The buyer's rules, in order. Pure functions: same quote and mandate always give the same answer.
//  1. filter: allowed sku, unit cap, over-order limit, budget, per-charge limit
//  2. improvement lever: pay-now still unused and rounds left -> counter on the eligible option with the lowest net unit
//  3. accept when net unit <= reference and total <= auto-approve; ask for approval over the auto limit; counter above reference
export function evaluateOption(option, { mandate, request, remainingBudgetCents, baselineTotalCents }) {
  const reasons = []
  const line = lineItemFor(mandate, option.sku)
  const neg = mandate.negotiation
  const qtyPct = pctChange(request.qty, option.qty)
  const spendPct = baselineTotalCents ? pctChange(baselineTotalCents, option.total_cents) : 0
  if (!line) reasons.push({ code: 'sku_not_allowed', text: `${option.sku} is not in the mandate` })
  else if (option.unit_cents > line.unit_cap_cents) reasons.push({ code: 'above_cap', text: `${fmt(option.unit_cents)}/case is above the ${fmt(line.unit_cap_cents)} cap` })
  if (option.qty * 100 > request.qty * (100 + neg.max_overorder_pct)) {
    reasons.push({ code: 'over_order_limit', text: `+${qtyPct}% quantity, +${spendPct}% spend vs request, limit ${neg.max_overorder_pct}%` })
  }
  if (option.total_cents > remainingBudgetCents) reasons.push({ code: 'over_budget', text: `${fmt(option.total_cents)} is more than the ${fmt(remainingBudgetCents)} left in the mandate` })
  if (option.total_cents > mandate.payment.amount_range.max_cents) reasons.push({ code: 'over_charge_limit', text: `${fmt(option.total_cents)} is above the ${fmt(mandate.payment.amount_range.max_cents)} per-charge range` })
  return { option_id: option.option_id, label: option.label, eligible: reasons.length === 0, reasons, qty_increase_pct: qtyPct, spend_increase_pct: spendPct, reference_unit_cents: line?.reference_unit_cents ?? null, cap_unit_cents: line?.unit_cap_cents ?? null }
}

export function evaluateQuote({ mandate, request, quote, remainingBudgetCents, baselineTotalCents }) {
  const maxRounds = Math.min(mandate.negotiation.max_rounds, 4)
  const canCounter = quote.can_counter && quote.version < maxRounds
  const ctx = { mandate, request, remainingBudgetCents, baselineTotalCents }
  const options = quote.options.map((o) => ({ ...evaluateOption(o, ctx), ...pick(o) }))
  const eligible = options.filter((o) => o.eligible)
  const byNet = (a, b) => a.net_unit_cents - b.net_unit_cents

  if (eligible.length === 0) {
    const capOnly = options.filter((o) => o.reasons.every((r) => r.code === 'above_cap'))
    if (capOnly.length && canCounter) {
      const target = [...capOnly].sort(byNet)[0]
      return { options, decision: { action: 'counter', option_id: target.option_id, levers: { pay_now: target.pay_now_available, ask_lower_price: true }, reason: 'Every option is above the unit cap, asking for a better price.' } }
    }
    const least = [...options].sort(byNet)[0]
    return { options, decision: { action: 'approval', option_id: least.option_id, reason: `No option fits the mandate: ${least.reasons.map((r) => r.text).join('; ')}` } }
  }

  const lever = eligible.filter((o) => o.pay_now_available && quote.pay_now_offered).sort(byNet)[0]
  if (lever && canCounter) {
    return { options, decision: { action: 'counter', option_id: lever.option_id, levers: { pay_now: true, ask_lower_price: false }, reason: 'Improvement lever: pay-now discount not used yet and rounds remain.' } }
  }
  const best = [...eligible].sort(byNet)[0]
  const withinReference = best.reference_unit_cents !== null && best.net_unit_cents <= best.reference_unit_cents
  if (withinReference && best.total_cents <= mandate.negotiation.auto_approve_cents) {
    return { options, decision: { action: 'accept', option_id: best.option_id, reason: `Net ${fmt(best.net_unit_cents)}/case is at or under the ${fmt(best.reference_unit_cents)} reference.` } }
  }
  if (withinReference) {
    return { options, decision: { action: 'approval', option_id: best.option_id, reason: `${fmt(best.total_cents)} is above the ${fmt(mandate.negotiation.auto_approve_cents)} auto-approve limit.` } }
  }
  if (canCounter) {
    return { options, decision: { action: 'counter', option_id: best.option_id, levers: { pay_now: best.pay_now_available, ask_lower_price: true }, reason: `Net ${fmt(best.net_unit_cents)}/case is above the ${fmt(best.reference_unit_cents)} reference.` } }
  }
  return { options, decision: { action: 'approval', option_id: best.option_id, reason: 'Rounds are used up and the price is still above the reference.' } }
}

const pick = (o) => ({ sku: o.sku, qty: o.qty, unit_cents: o.unit_cents, total_cents: o.total_cents, net_unit_cents: o.net_unit_cents, pay_now: o.pay_now, pay_now_available: o.pay_now_available, terms: o.terms })

// Guard used by accept_quote no matter who picked the option (rules or a model): the same checks again,
// plus the auto-approve ceiling and the reference price. Anything outside becomes an approval card.
export function acceptGuard({ mandate, request, option, remainingBudgetCents, baselineTotalCents, expired }) {
  const e = evaluateOption(option, { mandate, request, remainingBudgetCents, baselineTotalCents })
  const reasons = [...e.reasons]
  if (expired) reasons.push({ code: 'mandate_expired', text: 'The mandate has expired' })
  const reference = e.reference_unit_cents
  if (reference !== null && option.net_unit_cents > reference) reasons.push({ code: 'above_reference', text: `Net ${fmt(option.net_unit_cents)}/case is above the ${fmt(reference)} reference` })
  if (option.total_cents > mandate.negotiation.auto_approve_cents) reasons.push({ code: 'above_auto_approve', text: `${fmt(option.total_cents)} is above the ${fmt(mandate.negotiation.auto_approve_cents)} auto-approve limit` })
  return { ok: reasons.length === 0, reasons, evaluation: e }
}
