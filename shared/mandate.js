import { z } from 'zod'
import { sha256hex, signJws, verifyJws } from './jws.js'

// AP2-inspired mandate (inspired by AP2, not the same structure):
//   checkout.allowed_merchants / checkout.line_items  ~ Open Checkout Mandate
//   payment.amount_range / allowed_payees / allowed_payment_instruments / budget / agent_recurrence ~ Open Payment Mandate
// agent_recurrence is ON_DEMAND because re-orders happen when stock runs low, not on a calendar.
export const mandateSchema = z.object({
  mandate_id: z.string(),
  label: z.string(),
  version: z.literal(1),
  issuer: z.object({ company: z.string(), signed_by: z.string(), buyer_id: z.string() }),
  issued_at: z.string(),
  expires_at: z.string(),
  checkout: z.object({
    allowed_merchants: z.array(z.string()).min(1),
    line_items: z.array(z.object({
      sku: z.string(),
      category: z.string(),
      unit_cap_cents: z.number().int().positive(),
      reference_unit_cents: z.number().int().positive(),
    })).min(1),
  }),
  payment: z.object({
    amount_range: z.object({ currency: z.literal('USD'), min_cents: z.number().int(), max_cents: z.number().int() }),
    allowed_payees: z.array(z.string()).min(1),
    allowed_payment_instruments: z.array(z.object({ type: z.literal('paypal_vault'), label: z.string() })).min(1),
    budget: z.object({ currency: z.literal('USD'), total_cents: z.number().int().positive() }),
    agent_recurrence: z.object({ frequency: z.literal('ON_DEMAND') }),
  }),
  negotiation: z.object({
    max_overorder_pct: z.number().int().min(0).max(500),
    auto_approve_cents: z.number().int().positive(),
    max_rounds: z.number().int().min(1).max(6),
  }),
})

export const mandateHash = (mandate) => sha256hex(mandate)

export function signMandate(mandate, signer) {
  return signJws({ type: 'mandate', mandate, mandate_hash: mandateHash(mandate) }, signer)
}

export function openMandate(jws, publicJwk) {
  const payload = verifyJws(jws, publicJwk)
  const mandate = mandateSchema.parse(payload.mandate)
  if (payload.mandate_hash !== mandateHash(mandate)) throw new Error('mandate hash mismatch')
  return mandate
}

export function lineItemFor(mandate, sku) {
  return mandate.checkout.line_items.find((l) => l.sku === sku) || null
}
