import { randomBytes } from 'node:crypto'
import { runClaimed } from '../shared/claims.js'
import { assertKnownVault } from './vault.js'

const REFUND_LEASE_MS = 2 * 60 * 1000

// Judge account only: every live or mock charge is refunded 10 minutes later so the shared balance never runs out.
export function scheduleJudgeRefund({ db, config, charge, clock = () => Date.now() }) {
  const job = { id: charge.capture_id, capture_id: charge.capture_id, quote_id: charge.quote_id, invoice_id: charge.invoice_id, invoice_ref: charge.invoice_ref, amount_cents: charge.amount_cents, rail: charge.rail, due_at: clock() + config.judge.autoRefundDelayMs, state: 'scheduled', attempts: 0 }
  db.put('refund_jobs', job.id, job)
  return job
}

// The claim: one db.tx moves a job from scheduled to refunding. Only that caller reaches PayPal; a concurrent run
// finds the job already refunding and skips it. A refunding job older than the lease is taken over (the call may have
// reached PayPal, so its request id is kept). The capture must be one this supplier charged.
function claimRefund(db, id, clock) {
  return db.tx(() => {
    const cur = db.get('refund_jobs', id)
    if (!cur) return null
    const stale = cur.state === 'refunding' && clock() - cur.claimed_at > REFUND_LEASE_MS
    if (cur.state !== 'scheduled' && !stale) return null
    if (!db.get('charges', cur.capture_id)) {
      db.put('refund_jobs', id, { ...cur, state: 'failed', last_error: 'capture is not one this supplier charged' })
      return null
    }
    const claimed = { ...cur, state: 'refunding', claimed_at: clock(), request_id: cur.request_id || randomBytes(12).toString('hex') }
    db.put('refund_jobs', id, claimed)
    return claimed
  })
}

export async function runDueRefunds({ db, config, paypalFor, limits, events, clock = () => Date.now() }) {
  const due = db.list('refund_jobs', (j) => (j.state === 'scheduled' && j.due_at <= clock()) || (j.state === 'refunding' && clock() - j.claimed_at > REFUND_LEASE_MS))
  const results = []
  for (const listed of due) {
    const job = claimRefund(db, listed.id, clock)
    if (!job) continue
    const paypal = paypalFor(job.rail)
    try {
      const refund = await paypal.refundCapture(job.capture_id, job.amount_cents, job.invoice_id, { requestId: job.request_id })
      let recorded = Boolean(job.invoice_ref)
      try {
        if (job.invoice_ref) await paypal.recordRefund(job.invoice_ref, job.amount_cents)
      } catch {
        recorded = false
      }
      db.put('refund_jobs', job.id, { ...job, state: refund.status === 'PENDING' ? 'pending_at_paypal' : 'done', refund_id: refund.id, invoice_recorded: recorded, done_at: new Date(clock()).toISOString() })
      const charge = db.get('charges', job.capture_id)
      if (charge) db.put('charges', job.capture_id, { ...charge, refunded: true, refund_id: refund.id })
      if (job.rail === 'live' && refund.status !== 'PENDING') limits.adjustBalance(job.amount_cents)
      events.emit('judge_refund', { quote_id: job.quote_id, capture_id: job.capture_id, refund_id: refund.id, status: refund.status })
      results.push({ id: job.id, ok: true })
    } catch (err) {
      const attempts = job.attempts + 1
      // An unknown outcome keeps the request id (PayPal can join the retry to the first call); a refusal starts fresh.
      const request_id = err?.outcome === 'unknown' || err?.outcome === undefined ? job.request_id : null
      db.put('refund_jobs', job.id, { ...job, request_id, attempts, due_at: clock() + 5 * 60 * 1000, last_error: err.message, state: attempts >= 6 ? 'failed' : 'scheduled' })
      events.emit('judge_refund_failed', { quote_id: job.quote_id, capture_id: job.capture_id, error: err.message, attempts })
      results.push({ id: job.id, ok: false, error: err.message })
    }
  }
  return results
}

export function startRefundScheduler(ctx) {
  const timer = setInterval(() => { runDueRefunds(ctx).catch((err) => console.error('[refund scheduler]', err.message)) }, 30000)
  timer.unref()
  return timer
}

// Daily check of the vault, capture and refund path with a one-dollar charge on the judge account.
// The charge carries a co-signature of the buyer agent (custom_id = its hash, invoice id = its invoice number), like
// every other charge, so the buyer's audit pairs it instead of raising an alert. One check per co-signature.
// The claim is the day: two checks in flight on the same day would charge twice.
export async function healthCheck({ db, paypalFor, vault, events, cosign }) {
  const result = { at: new Date().toISOString(), ok: false, detail: '' }
  if (!vault || !vault.active) {
    result.detail = 'no saved judge PayPal'
  } else if (!cosign?.hash || !cosign?.invoiceId) {
    result.detail = 'the buyer agent has not co-signed this check'
  } else {
    const paypal = paypalFor(vault.rail === 'sandbox' ? 'live' : 'mock')
    try {
      assertKnownVault(db, vault.vault_id)
      await runClaimed(db, `health:${result.at.slice(0, 10)}`, async (requestId) => {
        const ref = cosign.invoiceId
        const order = await paypal.chargeVault({ vaultId: vault.vault_id, amountCents: 100, invoiceId: ref, customId: cosign.hash, requestId: `health-${requestId}` })
        const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
        const refund = await paypal.refundCapture(capture.id, 100, undefined, { requestId: `health-${requestId}-refund` })
        result.ok = order.status === 'COMPLETED' && ['COMPLETED', 'PENDING'].includes(refund.status)
        result.detail = `charge ${capture.id} refund ${refund.id} (${refund.status})`
      })
    } catch (err) {
      result.detail = err.message
    }
  }
  db.put('health', 'last', result)
  events.emit('health_check', result)
  return result
}
