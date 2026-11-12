// Buyer-side audit: read the buyer's own PayPal activity (not the supplier's messages) and pair every
// outgoing charge with a co-signature the buyer issued. Refunds coming in are not charges.
//
// The pause and the acknowledgement are kept per visitor (a public demo has many people on one PayPal account):
// Resume acknowledges the alerts that exist now, and an acknowledged transaction never pauses again.
// The supplier's demo button tags its charge with the visitor who pressed it, so it alerts only that visitor.
export const DEMO_CHARGE_TAG = 'supplier-did-not-ask'
const demoOwner = (custom) => (typeof custom === 'string' && custom.startsWith(`${DEMO_CHARGE_TAG}:`) ? custom.slice(DEMO_CHARGE_TAG.length + 1) : null)
const NO_PERMISSION = 'Transaction Search permission is not enabled for this PayPal app, so the buyer cannot read its own activity yet. Showing only the co-signatures this agent issued.'

const isPermissionError = (err) => ['paypal_credentials', 'paypal_auth'].includes(err?.code) || /NOT_AUTHORIZED|refused our credentials/i.test(String(err?.message))

export async function auditActivity({ db, paypal, config, visitor = 'anonymous', now = Date.now(), windowDays = 3 }) {
  const start = new Date(now - windowDays * 86400000).toISOString().replace(/\.\d+Z$/, 'Z')
  const end = new Date(now + 60000).toISOString().replace(/\.\d+Z$/, 'Z')
  const source = paypal.mode === 'mock' ? 'bundled mock' : config.activitySide === 'payee' ? 'PayPal sandbox (supplier account view)' : 'PayPal sandbox'
  const prior = auditState(db, visitor)
  const acked = new Set(prior.acked || [])
  let data
  let unavailable = null
  try {
    data = await paypal.listTransactions(start, end)
  } catch (err) {
    if (!isPermissionError(err)) throw err
    data = { transaction_details: [] }
    unavailable = { code: 'transaction_search_not_enabled', message: NO_PERMISSION }
  }
  const cosigns = db.list('cosigns')
  const { details, ignored } = forBuyer(data.transaction_details || [], cosigns, config.activitySide)
  const claimed = new Set()
  const rows = []
  const outgoingById = new Map()

  for (const d of details) {
    const info = d.transaction_info || {}
    const amount = Number(info.transaction_amount?.value)
    if (!(amount < 0)) continue
    const custom = info.custom_field
    let match = custom ? cosigns.find((c) => c.cosign_hash === custom && !claimed.has(c.cosign_hash)) : null
    let status = 'alert'
    let note = 'Charge without a matching co-signature'
    const owner = demoOwner(custom)
    const skip = owner && owner !== visitor
      ? { status: 'other_visitor_demo', note: 'Demo charge pressed by another visitor, not an alert for you' }
      : acked.has(info.transaction_id) ? { status: 'alert_acknowledged', note: 'Charge without a co-signature, acknowledged when you resumed co-signing' } : null
    if (match) {
      const sameAmount = Math.abs(amount) === Number(match.amount)
      const sameInvoice = !info.invoice_id || info.invoice_id === match.invoice_number
      if (sameAmount && sameInvoice) { status = 'matched'; note = 'Co-signature found in PayPal record' } else { match = null; note = 'Co-signature found but amount or invoice differs' }
    } else if (!custom) {
      // The payer side of Transaction Search may not show the supplier's custom field: fall back to amount and time,
      // only against this visitor's own co-signatures (another visitor's identical deal must not be claimed).
      const at = Date.parse(info.transaction_initiation_date)
      match = cosigns.find((c) => !claimed.has(c.cosign_hash) && (!c.visitor || c.visitor === visitor) && Number(c.amount) === Math.abs(amount) && at >= Date.parse(c.created_at) - 60000 && at <= c.exp * 1000 + 3600000)
      if (match) { status = 'matched_weak'; note = 'Matched by amount and time only (custom field not visible)' }
    }
    if (!match && skip) ({ status, note } = skip)
    if (match) claimed.add(match.cosign_hash)
    const row = { kind: 'charge', owner: match ? match.visitor || null : owner, status, transaction_id: info.transaction_id, amount, invoice_id: info.invoice_id || null, quote_id: match?.quote_id || null, at: info.transaction_initiation_date, cosign_hash: match?.cosign_hash || null, refunded: false, note }
    rows.push(row)
    outgoingById.set(info.transaction_id, row)
  }

  for (const d of details) {
    const info = d.transaction_info || {}
    const amount = Number(info.transaction_amount?.value)
    if (!(amount > 0)) continue
    const original = (info.paypal_reference_id && outgoingById.get(info.paypal_reference_id)) || (info.invoice_id ? [...outgoingById.values()].find((r) => r.invoice_id === info.invoice_id && !r.refunded) : null)
    if (original) {
      original.refunded = true
      original.refund_amount = amount
      rows.push({ kind: 'incoming', owner: original.owner, status: 'refund', transaction_id: info.transaction_id, amount, invoice_id: info.invoice_id || null, quote_id: original.quote_id, at: info.transaction_initiation_date, refund_of: original.transaction_id, note: 'Refund of a captured charge' })
    } else {
      rows.push({ kind: 'incoming', status: 'unmatched_incoming', transaction_id: info.transaction_id, amount, at: info.transaction_initiation_date, note: 'Incoming payment, not a charge' })
    }
  }

  for (const c of cosigns) {
    if (claimed.has(c.cosign_hash) || c.state === 'unused') continue
    if (c.visitor && c.visitor !== visitor) continue
    if (c.rail === 'simulated') { rows.push({ kind: 'cosign_only', status: 'simulated', quote_id: c.quote_id, amount: -Number(c.amount), invoice_id: c.invoice_number, at: c.created_at, note: 'Simulated PayPal calls, not in your PayPal records' }); continue }
    if (c.state !== 'charged') continue
    const age = now - Date.parse(c.created_at)
    if (unavailable) { rows.push({ kind: 'cosign_only', status: 'unverified', quote_id: c.quote_id, amount: -Number(c.amount), invoice_id: c.invoice_number, at: c.created_at, note: 'Co-signed by this agent. Not checked against PayPal (permission missing).' }); continue }
    const visibleBy = new Date(Date.parse(c.created_at) + config.searchLagMs).toISOString()
    const pendingNote = paypal.mode === 'mock'
      ? `Pending: the bundled mock shows a charge ${Math.round(config.searchLagMs / 60000)} min after it happens (PayPal: up to 3 h).`
      : `Pending in your PayPal activity (PayPal can take up to 3 h).`
    rows.push({ kind: 'cosign_only', status: age < config.searchLagMs ? 'pending' : 'cosigned_no_charge_seen', quote_id: c.quote_id, amount: -Number(c.amount), invoice_id: c.invoice_number, at: c.created_at, visible_by: visibleBy, note: age < config.searchLagMs ? pendingNote : 'Co-signed, but no charge in your PayPal records' })
  }

  // The activity list is read per PayPal account, but a public demo has many visitors on one judge account.
  // Each row is owned by the visitor whose co-signature it matched (or who pressed the demo charge); other visitors' rows
  // are counted, not listed. Rows nobody owns (yesterday's seeded deal, an unsigned charge from anywhere) are shown to everyone.
  const mine = rows.filter((r) => !r.owner || r.owner === visitor).map(({ owner, ...r }) => r)
  const others = rows.filter((r) => r.owner && r.owner !== visitor && r.kind === 'charge').length
  const alerts = mine.filter((r) => r.status === 'alert')
  const result = { at: new Date(now).toISOString(), source, side: config.activitySide === 'payee' ? 'payee' : 'payer', unavailable, rows: mine.sort((a, b) => String(b.at).localeCompare(String(a.at))), alerts, matched: mine.filter((r) => r.status.startsWith('matched')).length, other_visitors: others, ignored }
  db.put('state', `audit_last:${visitor}`, result)
  if (alerts.length) {
    db.put('state', `audit:${visitor}`, { ...prior, paused: true, since: prior.paused ? prior.since : new Date(now).toISOString(), alerts: alerts.map((a) => ({ transaction_id: a.transaction_id, amount: a.amount, invoice_id: a.invoice_id })) })
  }
  return result
}

// The audit reads the payer's activity, where a charge is negative. A sandbox demo that has only one REST app (the supplier's)
// reads the payee side instead (BUYER_ACTIVITY_SIDE=payee): signs are flipped, and rows that carry no QuoteLoop invoice number,
// co-signature hash or demo tag are left out, because the shared sandbox account also holds other merchants' sales.
function forBuyer(details, cosigns, side) {
  if (side !== 'payee') return { details, ignored: 0 }
  const hashes = new Set(cosigns.map((c) => c.cosign_hash))
  const invoices = new Set(cosigns.map((c) => c.invoice_number).filter(Boolean))
  const ours = (i) => hashes.has(i.custom_field) || invoices.has(i.invoice_id) || (typeof i.custom_field === 'string' && i.custom_field.startsWith(DEMO_CHARGE_TAG))
  const charges = new Set(details.filter((d) => ours(d.transaction_info || {}) && Number(d.transaction_info.transaction_amount?.value) > 0).map((d) => d.transaction_info.transaction_id))
  const kept = details.filter((d) => {
    const i = d.transaction_info || {}
    return ours(i) || charges.has(i.paypal_reference_id)
  }).map((d) => {
    const i = d.transaction_info
    const value = -Number(i.transaction_amount.value)
    return { ...d, transaction_info: { ...i, transaction_amount: { ...i.transaction_amount, value: value.toFixed(2) } } }
  })
  return { details: kept, ignored: details.length - kept.length }
}

export const auditState = (db, visitor = 'anonymous') => db.get('state', `audit:${visitor}`) || { paused: false, acked: [] }

// Resume: a human has seen the alerts. They are acknowledged for good, so the next check does not pause again for them.
export function resumeCosigning(db, visitor = 'anonymous') {
  const prior = auditState(db, visitor)
  const acked = [...new Set([...(prior.acked || []), ...(prior.alerts || []).map((a) => a.transaction_id)])]
  return db.put('state', `audit:${visitor}`, { paused: false, acked, resumed_at: new Date().toISOString() })
}
