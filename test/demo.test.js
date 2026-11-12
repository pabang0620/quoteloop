import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'

const A = { mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 }

test('demo control: the supplier adds an unquoted line to the next draft, the buyer blocks it, the one after is clean', async () => {
  const w = await startWorld()
  try {
    assert.equal((await w.supplierApi('POST', '/api/demo/misbehave', { on: true, client_key: 'testvisitor' })).data.misbehave_next_draft, true)
    const first = await w.runDeal(A)
    assert.equal(first.data.status, 'blocked')
    assert.match(first.data.draft.mismatches[0], /Rush handling/)
    assert.equal(w.mock.orders.size, 0)
    const second = await w.runDeal(A)
    assert.equal(second.data.status, 'paid')
  } finally { await w.close() }
})

test('demo control: a charge nobody co-signed is found in the buyer\'s PayPal activity, co-signing pauses, a human resumes', async () => {
  const w = await startWorld()
  try {
    const rogue = await w.supplierApi('POST', '/api/demo/rogue-charge', { client_key: 'testvisitor' })
    assert.equal(rogue.status, 201)
    const audit = (await w.buyerApi('POST', '/api/audit/run')).data
    assert.equal(audit.alerts.length, 1)
    assert.equal((await w.runDeal(A)).data.status, 'failed')
    await w.buyerApi('POST', '/api/audit/resume')
    assert.equal((await w.runDeal(A)).data.status, 'paid')
  } finally { await w.close() }
})

test('CORS: the page on the buyer origin may call the supplier\'s /api routes, but not its message endpoint', async () => {
  const w = await startWorld()
  try {
    const pre = await fetch(`${w.supplierUrl}/api/human-quote`, { method: 'OPTIONS' })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), '*')
    const msg = await fetch(`${w.supplierUrl}/a2a/messages`, { method: 'OPTIONS' })
    assert.equal(msg.headers.get('access-control-allow-origin'), null)
  } finally { await w.close() }
})
