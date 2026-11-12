import { z } from 'zod'
import { HttpError, ok, parse } from '../shared/http.js'
import { scheduleJudgeRefund } from './refunds.js'
import { runClaimed } from '../shared/claims.js'
import { sha256hex } from '../shared/jws.js'
import { assertKnownVault, vaultFor } from './vault.js'
import { setDemoStock } from './catalog.js'

// Demo controls that make the supplier misbehave, so a visitor can see the buyer's defences work.
// Both only touch the shared judge account and are labelled as demo controls on the page.
export function demoRoutes(app, ctx) {
  const { db, config, events, limits } = ctx

  const clientBody = z.object({ client_key: z.string().max(80).default('anonymous') })

  // The next invoice draft of this visitor carries an extra "Rush handling $40.00" line that was never quoted.
  app.post('/api/demo/misbehave', (req, res, next) => {
    try {
      const { on, client_key } = parse(clientBody.extend({ on: z.boolean() }), req.body)
      if (on) ctx.demo.misbehaveFor.add(client_key)
      else ctx.demo.misbehaveFor.delete(client_key)
      events.emit('demo_control', { misbehave_next_draft: on })
      ok(res, { misbehave_next_draft: on })
    } catch (err) { next(err) }
  })

  // For this visitor only: 12oz hot cups show fewer cases than a request asks for, so the supplier has to offer a substitute.
  app.post('/api/demo/low-stock', (req, res, next) => {
    try {
      const { on, client_key } = parse(clientBody.extend({ on: z.boolean() }), req.body)
      setDemoStock(db, client_key, on ? { sku: 'CUP-12-HOT', available: 1 } : null)
      events.emit('demo_control', { low_stock_for_visitor: on })
      ok(res, { low_stock: on, sku: 'CUP-12-HOT', available: on ? 1 : null })
    } catch (err) { next(err) }
  })

  // The supplier charges the saved judge PayPal without asking the buyer agent for a co-signature. The custom_id carries
  // the visitor who pressed the button, so the buyer's audit raises the alert for that visitor only.
  app.post('/api/demo/rogue-charge', async (req, res, next) => {
    try {
      const { client_key } = parse(z.object({ client_key: z.string().max(80).default('anonymous') }), req.body)
      const vault = vaultFor(db, 'brightcup-cafes')
      if (!vault || vault.account_kind !== 'judge') throw new HttpError(403, 'The rogue-charge demo only runs on the judge sandbox account', 'forbidden')
      const { rail } = limits.decideRail({ clientKey: client_key, networkKey: `ip:${sha256hex(req.ip || '')}`.slice(0, 20), paypalMode: ctx.primary.mode, accountKind: 'judge', amountCents: 1999 })
      if (rail === 'simulated') throw new HttpError(409, 'Live sandbox runs are used up for today, so this demo is paused.', 'limit')
      assertKnownVault(db, vault.vault_id)
      const paypal = ctx.paypalFor(rail)
      // One rogue charge at a time; the invoice id comes from the claim's request id so a retry after a lost answer is the same charge.
      const { order, invoiceId } = await runClaimed(db, 'rogue:charge', async (requestId) => {
        const invoiceId = `INV-ROGUE-${requestId.slice(0, 8)}`
        const order = await paypal.chargeVault({ vaultId: vault.vault_id, amountCents: 1999, invoiceId, customId: `supplier-did-not-ask:${client_key}`, requestId })
        return { order, invoiceId }
      })
      const capture = order.purchase_units[0].payments.captures[0]
      const charge = { quote_id: null, order_id: order.id, capture_id: capture.id, amount_cents: 1999, vault_id: vault.vault_id, account_kind: 'judge', rail, custom_id: `supplier-did-not-ask:${client_key}`, invoice_id: invoiceId, invoice_ref: null, at: new Date().toISOString(), refunded: false, rogue: true }
      db.put('charges', capture.id, charge)
      if (rail === 'live') limits.adjustBalance(-1999)
      scheduleJudgeRefund({ db, config, charge })
      events.emit('rogue_charge', { capture_id: capture.id, amount_cents: 1999 })
      ok(res, { capture_id: capture.id, amount_cents: 1999 }, 201)
    } catch (err) { next(err) }
  })
}
