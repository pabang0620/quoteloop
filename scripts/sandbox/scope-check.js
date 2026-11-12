// Read-only: which scopes does the sandbox token carry, and does Transaction Search answer? Prints no secrets.
import dotenv from 'dotenv'
dotenv.config({ path: process.env.ENV_FILE || '.env', quiet: true })
const base = 'https://api-m.sandbox.paypal.com'
async function check(label, id, secret) {
  if (!id || !secret) return console.log(`${label}: no credentials`)
  const auth = Buffer.from(`${id}:${secret}`).toString('base64')
  const t = await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  const tok = await t.json()
  const scopes = String(tok.scope || '').split(' ')
  const hasSearch = scopes.includes('https://uri.paypal.com/services/reporting/search/read')
  const end = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const start = new Date(Date.now() - 3 * 86400000).toISOString().replace(/\.\d+Z$/, 'Z')
  const r = await fetch(`${base}/v1/reporting/transactions?start_date=${start}&end_date=${end}&fields=all&page_size=100`, { headers: { Authorization: `Bearer ${tok.access_token}` } })
  const body = await r.json().catch(() => ({}))
  console.log(`${label}: token ${t.status}, ${scopes.length} scopes, reporting/search/read=${hasSearch}, transactions ${r.status} ${body.name || ''} rows=${body.transaction_details?.length ?? '-'}`)
}
await check('buyer', process.env.BUYER_PAYPAL_CLIENT_ID, process.env.BUYER_PAYPAL_CLIENT_SECRET)
await check('supplier', process.env.SUPPLIER_PAYPAL_CLIENT_ID, process.env.SUPPLIER_PAYPAL_CLIENT_SECRET)
