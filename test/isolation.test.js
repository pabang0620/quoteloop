import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { startWorld } from './helpers.js'

const root = new URL('..', import.meta.url).pathname
const files = (dir) => readdirSync(join(root, dir)).flatMap((f) => {
  const p = join(dir, f)
  return statSync(join(root, p)).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : []
})
const read = (p) => readFileSync(join(root, p), 'utf8')

test('buyer code never imports supplier or mock-PayPal code, and the supplier never imports buyer code', () => {
  for (const f of files('buyer')) assert.doesNotMatch(read(f), /from '\.\.\/(supplier|mockpaypal)\//, f)
  for (const f of files('supplier')) assert.doesNotMatch(read(f), /from '\.\.\/(buyer|mockpaypal)\//, f)
  for (const f of files('shared')) assert.doesNotMatch(read(f), /from '\.\.\/(buyer|supplier|mockpaypal)\//, f)
})

test('each service reads only its own environment variables', () => {
  for (const f of files('buyer')) assert.doesNotMatch(read(f), /env\.(SUPPLIER|MOCK_PAYPAL_PORT)/, f)
  for (const f of files('supplier')) assert.doesNotMatch(read(f), /env\.BUYER_/, f)
  assert.match(read('buyer/config.js'), /BUYER_PAYPAL_CLIENT_ID/)
  assert.match(read('supplier/config.js'), /SUPPLIER_PAYPAL_CLIENT_ID/)
})

test('the two services hold different keys, different PayPal credentials and different databases', async () => {
  const w = await startWorld()
  try {
    assert.notEqual(w.buyer.ctx.signer.kid, w.supplier.ctx.signer.kid)
    assert.notEqual(w.buyer.ctx.db, w.supplier.ctx.db)
    await w.runDeal({ mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    const buyerDump = JSON.stringify(w.buyer.ctx.db.dump())
    const supplierDump = JSON.stringify(w.supplier.ctx.db.dump())
    assert.ok(!buyerDump.includes('mock-supplier-secret') && !buyerDump.includes('vault_id'), 'buyer database holds no supplier credentials or saved-PayPal token')
    assert.ok(!supplierDump.includes('mock-buyer') && !supplierDump.includes('cosign_jws'), 'supplier database holds no buyer credentials')
    assert.ok(!supplierDump.includes('"mandates"') && !supplierDump.includes('budget'), 'supplier keeps no copy of the buyer ledger')
    // Different PayPal accounts: the buyer\'s credentials cannot charge anyone or read the supplier\'s invoices.
    await assert.rejects(() => w.buyer.ctx.paypal.rest('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }] }), /NOT_AUTHORIZED/)
    const inv = [...w.mock.invoices.keys()][0]
    await assert.rejects(() => w.buyer.ctx.paypal.getInvoice(inv), /INVALID_RESOURCE_ID|RESOURCE_NOT_FOUND/)
  } finally { await w.close() }
})
