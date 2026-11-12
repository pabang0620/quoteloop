import { z } from 'zod'
import { sha256hex } from './jws.js'

// Message types of the buyer <-> supplier protocol (A2A-shaped: Agent Card, task id, status).
export const MSG = {
  RFQ: 'RFQ',
  QUOTE: 'QUOTE',
  COUNTER: 'COUNTER',
  ACCEPT: 'ACCEPT',
  DRAFT_READY: 'DRAFT_READY',
  DRAFT_REJECT: 'DRAFT_REJECT',
  COSIGN: 'COSIGN',
  CHARGED: 'CHARGED',
  PAID: 'PAID',
  REGISTER: 'REGISTER',
  VAULT_SETUP: 'VAULT_SETUP',
  VAULT_STATUS: 'VAULT_STATUS',
  HEALTH_CHECK: 'HEALTH_CHECK',
  REFUND_SYNC: 'REFUND_SYNC',
  ACK: 'ACK',
  ERROR: 'ERROR',
}

export const TERMS = z.enum(['NET_30', 'DUE_ON_RECEIPT'])

export const optionSchema = z.object({
  option_id: z.string(),
  label: z.string(),
  sku: z.string(),
  name: z.string(),
  qty: z.number().int().positive(),
  list_unit_cents: z.number().int(),
  unit_cents: z.number().int(),
  concession_bps: z.number().int(),
  pay_now: z.boolean(),
  pay_now_available: z.boolean(),
  pay_now_discount_cents: z.number().int(),
  subtotal_cents: z.number().int(),
  total_cents: z.number().int(),
  net_unit_cents: z.number().int(),
  terms: TERMS,
  substitute_for: z.string().optional(),
})

export const quoteSchema = z.object({
  quote_id: z.string(),
  version: z.number().int().positive(),
  task_id: z.string(),
  supplier_id: z.string(),
  buyer_id: z.string(),
  currency: z.literal('USD'),
  options: z.array(optionSchema).min(1),
  issued_at: z.string(),
  expires_at: z.string(),
  can_counter: z.boolean(),
  pay_now_offered: z.boolean(),
  note: z.string().max(400).optional(),
})

// The hash the buyer's acceptance and every co-signature are bound to.
export const quoteHash = (quote) => sha256hex({ ...quote, note: undefined })

export const rfqBody = z.object({
  sku: z.string(),
  qty: z.number().int().positive().max(1000),
  need_by: z.string().max(40).optional(),
  note: z.string().max(400).optional(),
  mode: z.enum(['policy', 'claude']).default('policy'),
  client_key: z.string().max(80).default('anonymous'),
})

export const counterBody = z.object({
  quote_id: z.string(),
  option_id: z.string(),
  levers: z.object({ pay_now: z.boolean().default(false), ask_lower_price: z.boolean().default(false) }),
  note: z.string().max(400).optional(),
})

export const acceptBody = z.object({
  quote_id: z.string(),
  option_id: z.string(),
  quote_hash: z.string(),
  mandate_jws: z.string(),
  client_key: z.string().max(80).default('anonymous'),
  network_key: z.string().max(80).optional(),
})

export const cosignClaims = z.object({
  v: z.literal(1),
  payee: z.string(),
  amount: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.literal('USD'),
  invoice_number: z.string(),
  quote_id: z.string(),
  quote_hash: z.string(),
  mandate_id: z.string(),
  nonce: z.string().min(12),
  exp: z.number().int(),
})

export const draftRejectBody = z.object({ quote_id: z.string(), reason: z.string().max(400), mismatches: z.array(z.string()).max(20) })
export const healthBody = z.object({ cosign_jws: z.string() })
export const refundSyncBody = z.object({ quote_ids: z.array(z.string()).max(60) })
export const cosignBody = z.object({ quote_id: z.string(), cosign_jws: z.string() })
