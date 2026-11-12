// Read-only summary of the buyer app's own Transaction Search rows (no secrets, no emails).
import dotenv from 'dotenv'
dotenv.config({ path: process.env.ENV_FILE || '.env', quiet: true })
const base = 'https://api-m.sandbox.paypal.com'
const auth = Buffer.from(`${process.env.BUYER_PAYPAL_CLIENT_ID}:${process.env.BUYER_PAYPAL_CLIENT_SECRET}`).toString('base64')
const tok = await (await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json()
const end = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const start = new Date(Date.now() - 3 * 86400000).toISOString().replace(/\.\d+Z$/, 'Z')
const body = await (await fetch(`${base}/v1/reporting/transactions?start_date=${start}&end_date=${end}&fields=all&page_size=100`, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()
const rows = body.transaction_details || []
const neg = rows.filter((d) => Number(d.transaction_info.transaction_amount.value) < 0).length
console.log('rows', rows.length, 'negative', neg, 'withCustom', rows.filter((d) => d.transaction_info.custom_field).length)
for (const d of rows.filter((x) => x.transaction_info.custom_field).slice(0, 20)) {
  const i = d.transaction_info
  console.log(i.transaction_id, i.transaction_event_code, i.transaction_amount.value, i.invoice_id || '-', String(i.custom_field || '-').slice(0, 20), i.transaction_initiation_date)
}
