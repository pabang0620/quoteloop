import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'

test('a person with no buyer agent opens the supplier\'s quote link, pays on PayPal, and the invoice is marked PAID', async () => {
  const w = await startWorld({ connect: false })
  try {
    const made = await w.supplierApi('POST', '/api/human-quote', { sku: 'CUP-12-HOT', qty: 2, client_key: 'person' })
    assert.equal(made.status, 201)
    assert.equal(made.data.quote.options[0].total_cents, 25088, '2 x $128.00 less 2% pay-now')
    const page = await (await fetch(made.data.url)).text()
    assert.match(page, /Pay with PayPal/)
    const pay = await fetch(`${made.data.url}/pay`, { method: 'POST', redirect: 'manual' })
    assert.equal(pay.status, 302)
    const approveUrl = new URL(pay.headers.get('location'))
    assert.equal(approveUrl.pathname, '/mock/approve')
    const approve = await fetch(`${w.mockBase}/mock/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `order=${approveUrl.searchParams.get('order')}&payer=procurement&setup=` })
    assert.equal(approve.status, 302)
    const back = await fetch(approve.headers.get('location'))
    assert.match(await back.text(), /is paid/)
    assert.equal([...w.mock.invoices.values()][0].status, 'PAID')
    assert.equal(w.supplier.ctx.db.get('catalog', 'CUP-12-HOT').stock, 18)
  } finally { await w.close() }
})
