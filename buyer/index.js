import { createBuyerApp } from './app.js'
import { seedDemoHistory } from './seed.js'
import { envNotice } from '../shared/env.js'

const { app, ctx, ensureSupplier, runDailyCheck } = createBuyerApp()
const { config, paypal } = ctx

app.listen(config.port, async () => {
  console.log(`buyer agent on :${config.port} (PayPal ${paypal.mode})`)
  console.log(`[buyer] ${envNotice()}`)
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    try {
      await ensureSupplier()
      await seedDemoHistory({ db: ctx.db, config, paypal })
      console.log(`[buyer] introduced to ${ctx.card.supplier_id}`)
      setInterval(() => runDailyCheck().catch((err) => console.error('[buyer] daily check', err.message)), 24 * 3600 * 1000).unref()
      return
    } catch (err) {
      if (attempt === 15) console.log(`[buyer] supplier not reachable yet (${err.message}); will retry when a deal starts`)
      else await new Promise((r) => setTimeout(r, 1000))
    }
  }
})
