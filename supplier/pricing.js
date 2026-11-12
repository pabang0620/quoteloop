import { bpsOf, discountBy } from '../shared/money.js'

export function tierPrice(item, qty) {
  return [...item.tiers].reverse().find((t) => qty >= t.min)?.price_cents ?? item.tiers[0].price_cents
}

// Concession for a negotiation round. Zero when stock is at or under twice the safety stock.
export function concessionFor(item, round, availableCases) {
  if (availableCases <= item.safety_stock * 2) return 0
  const schedule = item.concession_bps
  return schedule[Math.min(Math.max(round, 1), schedule.length) - 1] ?? 0
}

// One priced line. Never goes below the floor (net per case, after every discount).
export function priceOption(item, { qty, round, payNow, availableCases }) {
  const listUnit = tierPrice(item, qty)
  const concessionBps = concessionFor(item, round, availableCases)
  let unit = discountBy(listUnit, concessionBps)
  let subtotal = unit * qty
  let payNowDiscount = payNow && item.pay_now_bps > 0 ? bpsOf(subtotal, item.pay_now_bps) : 0
  let total = subtotal - payNowDiscount
  const floorTotal = item.floor_cents * qty
  let floorClamped = false
  if (total < floorTotal) {
    floorClamped = true
    payNowDiscount = Math.max(0, subtotal - floorTotal)
    total = subtotal - payNowDiscount
    if (total < floorTotal) {
      unit = Math.max(unit, item.floor_cents)
      subtotal = unit * qty
      payNowDiscount = 0
      total = subtotal
    }
  }
  const payNowApplied = payNowDiscount > 0
  return {
    sku: item.sku,
    name: item.name,
    qty,
    list_unit_cents: listUnit,
    unit_cents: unit,
    concession_bps: concessionBps,
    pay_now: payNowApplied,
    pay_now_available: item.pay_now_bps > 0 && !payNowApplied,
    pay_now_discount_cents: payNowDiscount,
    subtotal_cents: subtotal,
    total_cents: total,
    net_unit_cents: Math.round(total / qty),
    terms: payNowApplied ? 'DUE_ON_RECEIPT' : item.base_terms,
    floor_clamped: floorClamped,
    score_cents: (Math.round(total / qty) - item.cost_cents) * qty,
  }
}

// Upsell: the next price tier above the requested quantity, if stock allows.
export function upsellQty(item, qty, availableCases) {
  if (!item.upsell) return null
  const next = item.tiers.find((t) => t.min > qty)
  return next && next.min <= availableCases ? next.min : null
}
