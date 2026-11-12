import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWorld } from './helpers.js'
import { autoConnectMock, dropLostMockVaults } from '../supplier/vault.js'

// Hosted bug: the supplier's database kept the demo buyer's vault id across a restart while the mock PayPal,
// which keeps its vault in memory, started empty. Every new visitor's charge then failed with INVALID_RESOURCE_ID.
test('after the mock PayPal loses its vault, the supplier start-up step reconnects and the next deal settles', async () => {
  const w = await startWorld()
  try {
    const first = await w.runDeal({ client_key: 'vfirst', mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    assert.equal(first.data.status, 'paid', JSON.stringify(first.data))
    const oldVault = w.supplier.ctx.db.get('vaults', 'brightcup-cafes').vault_id

    w.mock.vault.clear() // the mock process restarted; the supplier database did not

    const broken = await w.runDeal({ client_key: 'vsecond', mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    assert.equal(broken.data.status, 'failed')
    assert.match(broken.data.error, /INVALID_RESOURCE_ID/)

    const { db, config, primary, paypalFor } = w.supplier.ctx
    assert.deepEqual(await dropLostMockVaults({ db, paypalFor }), ['brightcup-cafes'])
    await autoConnectMock({ db, config, paypal: primary, buyerId: 'brightcup-cafes' })
    assert.notEqual(db.get('vaults', 'brightcup-cafes').vault_id, oldVault)

    const fresh = await w.runDeal({ client_key: 'vthird', mandate_id: 'MND-A-LEAN', sku: 'CUP-12-HOT', qty: 2 })
    assert.equal(fresh.data.status, 'paid', JSON.stringify(fresh.data))

    // A token the mock still knows is kept.
    assert.deepEqual(await dropLostMockVaults({ db, paypalFor }), [])
  } finally {
    await w.close()
  }
})
