import { signMandate, mandateSchema } from '../shared/mandate.js'
import { HttpError } from '../shared/http.js'

const iso = (ms) => new Date(ms).toISOString()

function base(config, id, label, hotCap, hotRef, overorderPct, now) {
  return mandateSchema.parse({
    mandate_id: id,
    label,
    version: 1,
    issuer: { company: config.company, signed_by: config.admin, buyer_id: config.buyerId },
    issued_at: iso(now),
    expires_at: iso(now + 90 * 24 * 3600 * 1000),
    checkout: {
      allowed_merchants: ['northbeam-supply'],
      line_items: [
        { sku: 'CUP-12-HOT', category: 'cups', unit_cap_cents: hotCap, reference_unit_cents: hotRef },
        { sku: 'CUP-12-RECYCLED', category: 'cups', unit_cap_cents: 14500, reference_unit_cents: 13800 },
        { sku: 'GRN-BURR-64', category: 'equipment-parts', unit_cap_cents: 120000, reference_unit_cents: 118000 },
      ],
    },
    payment: {
      amount_range: { currency: 'USD', min_cents: 100, max_cents: 150000 },
      allowed_payees: ['northbeam-supply'],
      allowed_payment_instruments: [{ type: 'paypal_vault', label: 'Procurement PayPal saved with Northbeam Supply' }],
      budget: { currency: 'USD', total_cents: 184000 },
      agent_recurrence: { frequency: 'ON_DEMAND' },
    },
    negotiation: { max_overorder_pct: overorderPct, auto_approve_cents: 50000, max_rounds: 4 },
  })
}

// Mandate A (Lean): never above $130/case, accept without asking at $127 net, at most +10% quantity.
// Mandate B (Bulk): never above $125/case, same reference, up to +60% quantity.
export function defaultMandates(config, now = Date.now()) {
  return [
    base(config, 'MND-A-LEAN', 'A Lean', 13000, 12700, 10, now),
    base(config, 'MND-B-BULK', 'B Bulk', 12500, 12700, 60, now),
  ]
}

export function storeMandate(db, mandate, signer, { visitor = null } = {}) {
  const jws = signMandate(mandate, signer)
  db.put('mandates', mandate.mandate_id, { mandate, jws, ...(visitor ? { visitor } : {}) })
  return { mandate, jws }
}

export function getMandate(db, id) {
  const m = db.get('mandates', id)
  if (!m) throw new HttpError(404, `Unknown mandate ${id}`, 'unknown_mandate')
  return m
}

// The budget of a signed mandate is kept per visitor: each person trying the demo spends from their own copy,
// so one judge's deals never use up what the next judge sees. Without a visitor (internal callers) the key is the mandate id.
const budgetKey = (mandateId, visitor) => (visitor ? `${mandateId}:${visitor}` : mandateId)
const EMPTY = { reserved: {}, spent_cents: 0 }

export function budgetState(db, mandate, visitor) {
  const b = db.get('budget', budgetKey(mandate.mandate_id, visitor)) || EMPTY
  const reserved = Object.values(b.reserved).reduce((s, c) => s + c, 0)
  return { total_cents: mandate.payment.budget.total_cents, spent_cents: b.spent_cents, reserved_cents: reserved, remaining_cents: mandate.payment.budget.total_cents - b.spent_cents - reserved }
}

// Reserve budget for a deal. The check and the write happen in one transaction, so two accepts
// racing for the last dollars cannot both succeed.
export function reserveBudget(db, mandate, dealId, cents, visitor) {
  return db.tx(() => {
    const key = budgetKey(mandate.mandate_id, visitor)
    const b = db.get('budget', key) || EMPTY
    const state = budgetState(db, mandate, visitor)
    const already = b.reserved[dealId] || 0
    if (cents - already > state.remaining_cents) throw new HttpError(409, 'Not enough budget left in this mandate', 'over_budget')
    db.put('budget', key, { ...b, reserved: { ...b.reserved, [dealId]: cents } })
    return budgetState(db, mandate, visitor)
  })
}

export function releaseBudget(db, mandateId, dealId, visitor) {
  db.tx(() => {
    const key = budgetKey(mandateId, visitor)
    const b = db.get('budget', key)
    if (!b?.reserved[dealId]) return
    const { [dealId]: _gone, ...rest } = b.reserved
    db.put('budget', key, { ...b, reserved: rest })
  })
}

export function commitBudget(db, mandateId, dealId, visitor) {
  db.tx(() => {
    const key = budgetKey(mandateId, visitor)
    const b = db.get('budget', key) || EMPTY
    const cents = b.reserved[dealId] || 0
    const { [dealId]: _gone, ...rest } = b.reserved
    db.put('budget', key, { reserved: rest, spent_cents: b.spent_cents + cents })
  })
}

// A refunded charge gives its money back to the budget (judge-account sales are refunded about 10 minutes later).
export function restoreSpent(db, mandateId, cents, visitor) {
  db.tx(() => {
    const key = budgetKey(mandateId, visitor)
    const b = db.get('budget', key) || EMPTY
    db.put('budget', key, { ...b, spent_cents: Math.max(0, b.spent_cents - cents) })
  })
}

export function resetBudgets(db) {
  for (const row of db.dump().filter((r) => r.col === 'budget')) db.del('budget', row.id)
}

// Default mandates plus the custom one this visitor signed.
export const mandatesFor = (db, visitor) => db.list('mandates', (m) => !m.visitor || m.visitor === visitor)
