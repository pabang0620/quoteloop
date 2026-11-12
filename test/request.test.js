import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRequestText } from '../buyer/request.js'
import { startWorld } from './helpers.js'

test('a short request becomes sku, quantity and date (the size 12oz is not a quantity)', () => {
  assert.deepEqual(parseRequestText('12oz hot cups, 2 cases, by Friday'), { sku: 'CUP-12-HOT', qty: 2, need_by: 'friday' })
  assert.deepEqual(parseRequestText('Grinder burr set, 1 unit'), { sku: 'GRN-BURR-64', qty: 1, need_by: undefined })
  assert.equal(parseRequestText('3 cases of recycled cups').sku, 'CUP-12-RECYCLED')
})

test('the supplier publishes an Agent Card and the buyer pins its key', async () => {
  const w = await startWorld()
  try {
    const card = await (await fetch(`${w.supplierUrl}/.well-known/agent-card.json`)).json()
    assert.equal(card.supplier_id, 'northbeam-supply')
    assert.equal(card.settlement.enforced_by, 'supplier code')
    assert.equal(w.buyer.ctx.db.get('peers', 'northbeam-supply').kid, card.kid)
    assert.equal(w.supplier.ctx.db.get('buyers', 'brightcup-cafes').public_jwk.x, w.buyer.ctx.signer.publicJwk.x)
  } finally { await w.close() }
})

test('a supplier that is not an allowed merchant is not even pinned', async () => {
  const w = await startWorld()
  try {
    await assert.rejects(() => w.buyer.ctx.supplier.discover(['someone-else']), /not an allowed merchant/)
  } finally { await w.close() }
})

test('the web page is served by the buyer when a build exists, and the API answers JSON errors', async () => {
  const w = await startWorld()
  try {
    const missing = await w.buyerApi('GET', '/api/deals/D-nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.success, false)
    const bad = await w.buyerApi('POST', '/api/deals', { mandate_id: 'MND-A-LEAN', qty: -2, sku: 'CUP-12-HOT' })
    assert.equal(bad.status, 400)
  } finally { await w.close() }
})
