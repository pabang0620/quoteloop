// Waits (up to 3 hours, checking every 5 minutes) until the given transaction ids show in the buyer app's Transaction Search.
// Prints only ids and the minutes waited.
import '../../shared/env.js'
const ids = process.argv.slice(2)
const base = 'https://api-m.sandbox.paypal.com'
const auth = Buffer.from(`${process.env.BUYER_PAYPAL_CLIENT_ID}:${process.env.BUYER_PAYPAL_CLIENT_SECRET}`).toString('base64')
const started = Date.now()
const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z')
while (Date.now() - started < 3 * 3600000) {
  const tok = await (await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json()
  const body = await (await fetch(`${base}/v1/reporting/transactions?start_date=${iso(Date.now() - 86400000)}&end_date=${iso(Date.now())}&page_size=500`, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()
  const seen = new Set((body.transaction_details || []).map((d) => d.transaction_info.transaction_id))
  const missing = ids.filter((id) => !seen.has(id))
  process.stdout.write(`${Math.round((Date.now() - started) / 60000)} min: visible ${ids.length - missing.length}/${ids.length}\n`)
  if (!missing.length) process.exit(0)
  await new Promise((r) => setTimeout(r, 5 * 60000))
}
process.exit(1)
