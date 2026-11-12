import { randomBytes } from 'node:crypto'
import { HttpError } from './http.js'

// A claim is a row of its own in `paypal_claims`, written before a PayPal write leaves the process.
// The key is a value every caller of the same operation computes the same (buyer, setup token, quote, order, day),
// never a per-attempt id. The row also holds the PayPal-Request-Id, so a retry after a lost answer reuses it
// and PayPal can join the two calls.
const COL = 'paypal_claims'
const LEASE_MS = 2 * 60 * 1000

export function claimWrite(db, key, { now = Date.now() } = {}) {
  return db.tx(() => {
    const row = db.get(COL, key)
    const stale = row?.state === 'CALLING' && now - Date.parse(row.at) > LEASE_MS
    if (row?.state === 'CALLING' && !stale) throw new HttpError(409, 'This PayPal step is already running', 'claim_in_flight')
    if (row?.state === 'DONE') throw new HttpError(409, 'This PayPal step is already done', 'claim_done')
    // A crashed or unanswered earlier attempt may have reached PayPal: keep its request id.
    const requestId = row?.request_id || randomBytes(12).toString('hex')
    db.put(COL, key, { key, state: 'CALLING', request_id: requestId, at: new Date(now).toISOString() })
    return { requestId }
  })
}

// PayPal said no, or the request never left: nothing happened, so the claim is released.
const releasable = (err) => err?.outcome === 'refused' || err?.outcome === 'not_sent' || (err instanceof HttpError && err.status >= 400 && err.status < 500)

// claim -> PayPal call -> record. keep=true leaves a DONE row (a step that can happen only once).
export async function runClaimed(db, key, call, { keep = false } = {}) {
  const { requestId } = claimWrite(db, key)
  try {
    const value = await call(requestId)
    if (keep) db.put(COL, key, { key, state: 'DONE', request_id: requestId, at: new Date().toISOString() })
    else db.del(COL, key)
    return value
  } catch (err) {
    if (releasable(err)) db.del(COL, key)
    else db.put(COL, key, { key, state: 'UNKNOWN', request_id: requestId, at: new Date().toISOString() })
    throw err
  }
}
