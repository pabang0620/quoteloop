import { HttpError } from '../shared/http.js'
import { randomId, sha256b64u, signJws } from '../shared/jws.js'
import { fromCents } from '../shared/money.js'
import { auditState } from './audit.js'

// A per-charge co-signature: the buyer agent signs "pay this payee exactly this amount against this invoice and quote".
// The supplier checks it before it charges the saved PayPal; the buyer later finds it again in its own PayPal records.
export function createCosign({ db, config, signer, deal, option, invoiceNumber, payeeId, now = Date.now() }) {
  if (auditState(db, deal.client_key).paused) throw new HttpError(423, 'Co-signing is paused after an audit alert. Resume it first.', 'cosign_paused')
  if (!deal.draft?.verified) throw new HttpError(409, 'The invoice draft has not passed verification', 'draft_not_verified')
  if (deal.draft.invoice_number !== invoiceNumber || deal.draft.total_cents !== option.total_cents) throw new HttpError(409, 'Verified draft does not match this charge', 'draft_mismatch')
  const earlier = db.list('cosigns', (c) => c.quote_id === deal.quote_id && c.exp * 1000 > now && c.state === 'issued')
  if (earlier.length) throw new HttpError(409, 'A live co-signature already exists for this quote', 'already_cosigned')
  const claims = {
    v: 1, payee: payeeId, amount: fromCents(option.total_cents), currency: 'USD', invoice_number: invoiceNumber,
    quote_id: deal.quote_id, quote_hash: deal.accepted.quote_hash, mandate_id: deal.mandate_id,
    nonce: randomId(12), exp: Math.floor(now / 1000) + config.cosignTtlSec,
  }
  const jws = signJws(claims, signer)
  const hash = sha256b64u(jws)
  const record = { cosign_hash: hash, jws, ...claims, deal_id: deal.deal_id, visitor: deal.client_key, state: 'issued', created_at: new Date(now).toISOString(), rail: null }
  db.put('cosigns', hash, record)
  return record
}

// The daily check of the saved PayPal is a charge like any other: it carries a co-signature of this buyer agent,
// so the buyer's own audit pairs it with the one-dollar charge instead of raising an alert.
export const HEALTH_AMOUNT_CENTS = 100
export function createHealthCosign({ db, config, signer, payeeId, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10)
  const invoiceNumber = `HEALTH-${day}`
  const existing = db.list('cosigns', (c) => c.invoice_number === invoiceNumber && c.exp * 1000 > now && c.state === 'issued')[0]
  if (existing) return existing
  const claims = {
    v: 1, payee: payeeId, amount: fromCents(HEALTH_AMOUNT_CENTS), currency: 'USD', invoice_number: invoiceNumber,
    quote_id: `HEALTH-${day}`, quote_hash: 'health-check', mandate_id: 'HEALTH-CHECK',
    nonce: randomId(12), exp: Math.floor(now / 1000) + config.cosignTtlSec,
  }
  const jws = signJws(claims, signer)
  const hash = sha256b64u(jws)
  const record = { cosign_hash: hash, jws, ...claims, deal_id: null, state: 'issued', created_at: new Date(now).toISOString(), rail: null, health: true }
  db.put('cosigns', hash, record)
  return record
}
