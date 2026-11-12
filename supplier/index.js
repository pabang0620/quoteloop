import { createSupplierApp } from './app.js'
import { syncPaypalProducts } from './catalog.js'
import { startRefundScheduler } from './refunds.js'
import { autoConnectMock, storePresetVault } from './vault.js'

const { app, ctx } = createSupplierApp()
const { config, db, primary, events } = ctx

app.listen(config.port, async () => {
  console.log(`supplier agent on :${config.port} (PayPal ${primary.mode})`)
  startRefundScheduler({ db, config, paypalFor: ctx.paypalFor, limits: ctx.limits, events })
  storePresetVault({ db, config, buyerId: 'brightcup-cafes' })
  try {
    await syncPaypalProducts(db, primary, (m) => console.log(`[supplier] ${m}`))
    await autoConnectMock({ db, config, paypal: primary, buyerId: 'brightcup-cafes' })
  } catch (err) {
    console.log(`[supplier] start-up step skipped: ${err.message}`)
  }
})
