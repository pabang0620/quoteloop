import express from 'express'
import { createEventBus, errorHandler, HttpError, ok } from '../shared/http.js'
import { loadSigningKey } from '../shared/jws.js'
import { createGate } from '../shared/messages.js'
import { createPaypal } from '../shared/paypal.js'
import { createAnthropicClient, llmFromConfig } from '../shared/llm.js'
import { openDb } from '../shared/docdb.js'
import { seedCatalog, listItems, availableStock } from './catalog.js'
import { loadSupplierConfig } from './config.js'
import { dispatch, registerBuyer } from './inbox.js'
import { createLimits, LOW_BALANCE_NOTICE, SIMULATION_NOTICE } from './limits.js'
import { runDueRefunds } from './refunds.js'
import { updatePriceItem } from './priceList.js'
import { handleWebhook } from './webhooks.js'
import { completeVaultSetup } from './vault.js'
import { demoRoutes } from './demo.js'
import { createHumanQuote, finishHumanPayment, quotePage, startHumanPayment } from './human.js'
import { z } from 'zod'
import { parse } from '../shared/http.js'

export const REFUND_DELAY_SANDBOX_MS = 10 * 60 * 1000
export const REFUND_DELAY_MOCK_MS = 2 * 60 * 1000

export function createSupplierApp(overrides = {}, injected = {}) {
  const loaded = loadSupplierConfig(overrides)
  const db = injected.db || openDb(loaded.dbFile)
  seedCatalog(db)
  const signer = injected.signer || loadSigningKey({ pem: loaded.keyPem, file: loaded.keyFile })
  const events = createEventBus()
  const mockClient = injected.mockPaypal || createPaypal({ label: 'supplier-sim', mockBase: loaded.paypal.mockBase, mockClientId: 'mock-supplier-client', mockClientSecret: 'mock-supplier-secret', forceMock: true })
  const primary = injected.paypal || createPaypal({ label: 'supplier', clientId: loaded.paypal.clientId, clientSecret: loaded.paypal.clientSecret, forceMock: loaded.paypal.forceMock, mockBase: loaded.paypal.mockBase, mockClientId: 'mock-supplier-client', mockClientSecret: 'mock-supplier-secret', vault: loaded.paypal.vault })
  // The judge-account refund waits are short on the bundled mock, so a judge walking the README sees it happen.
  const config = loaded.judge.autoRefundDelayMs == null
    ? { ...loaded, judge: { ...loaded.judge, autoRefundDelayMs: primary.mode === 'mock' ? REFUND_DELAY_MOCK_MS : REFUND_DELAY_SANDBOX_MS } }
    : loaded
  const paypalFor = (rail) => (rail === 'live' ? primary : rail === 'mock' && primary.mode === 'mock' ? primary : mockClient)
  const limits = createLimits({ db, config })
  const buyerKey = (buyerId) => db.get('buyers', buyerId)?.public_jwk || null
  const gate = createGate({ selfId: config.supplierId, signer, peerKey: buyerKey })
  const llm = injected.llm !== undefined ? injected.llm : llmFromConfig({ backend: config.llmBackend, anthropicKey: config.anthropicKey, model: config.model })
  const ctx = { db, config, signer, gate, events, primary, paypalFor, limits, buyerKey, llm, demo: { misbehaveFor: new Set() } }

  const card = () => ({
    name: config.name, protocol: 'A2A-shaped (Agent Card, task id, status)', version: '1.0.0',
    url: config.publicUrl, supplier_id: config.supplierId, kid: signer.kid, public_jwk: signer.publicJwk,
    payee: { id: config.supplierId, name: config.name, paypal_account: primary.mode },
    skills: [{ id: 'quote', name: 'Quote and settle wholesale orders', input: ['RFQ', 'COUNTER', 'ACCEPT', 'COSIGN'] }],
    negotiation: { max_rounds: config.maxRounds, pay_now_discount: true, over_order_upsell: true },
    settlement: { rails: ['paypal_vault_orders'], per_charge_limit_cents: config.perChargeLimitCents, requires: 'buyer agent co-signature per charge', enforced_by: 'supplier code' },
  })

  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use(express.urlencoded({ extended: false }))
  app.use((req, res, next) => {
    // The page is served by the buyer service, so its calls to the supplier's /api/* are cross-origin.
    if (req.path.startsWith('/api/') || req.path.startsWith('/.well-known/')) {
      res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' })
      if (req.method === 'OPTIONS') return res.status(204).end()
    }
    next()
  })

  app.get('/.well-known/agent-card.json', (req, res) => res.json(card()))
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'supplier', paypal: primary.mode }))

  app.post('/a2a/messages', async (req, res, next) => {
    try {
      const { jws } = parse(z.object({ jws: z.string() }), req.body)
      registerBuyer(ctx, jws)
      const msg = gate.open(jws)
      if (msg.type === 'REGISTER') return ok(res, { jws: gate.sign('ACK', msg.from, msg.task_id, { registered: true, supplier_kid: signer.kid }) })
      if (ctx.llm && !ctx.llm.client && ctx.llm.key && ctx.llm.backend !== 'account') ctx.llm.client = await createAnthropicClient(ctx.llm.key)
      const reply = await dispatch(ctx, msg)
      return ok(res, { jws: gate.sign(reply.type, msg.from, msg.task_id, reply.body) })
    } catch (err) { next(err) }
  })

  // PayPal webhook receiver (INVOICING.INVOICE.PAID). Signature checked by PayPal inside handleWebhook.
  app.post('/webhooks/paypal', async (req, res, next) => {
    try { ok(res, await handleWebhook(ctx, req.headers, req.body)) } catch (err) { next(err) }
  })

  app.get('/vault/return', async (req, res, next) => {
    try {
      const setupId = String(req.query.approval_token_id || req.query.setup || '')
      const vault = await completeVaultSetup({ db, config, paypal: primary, setupId })
      events.emit('vault_connected', { buyer_id: vault.buyer_id, account_kind: vault.account_kind, rail: vault.rail })
      res.redirect(`${config.buyerUiUrl}/?vault=connected`)
    } catch (err) { next(err) }
  })

  app.get('/api/state', (req, res) => {
    const clientKey = String(req.query.client || 'anonymous')
    const negs = db.list('negotiations').slice(-60).reverse()
    ok(res, {
      supplier: { id: config.supplierId, name: config.name, paypal_mode: primary.mode, per_charge_limit_cents: config.perChargeLimitCents, kid: signer.kid },
      catalog: listItems(db).map((i) => ({ sku: i.sku, name: i.name, tiers: i.tiers, floor_cents: i.floor_cents, stock: i.stock, available: availableStock(db, i, null, { clientKey }), safety_stock: i.safety_stock, concession_bps: i.concession_bps, pay_now_bps: i.pay_now_bps, paypal_product_id: i.paypal_product_id || null })),
      negotiations: negs.filter((n) => n.client_key === clientKey).slice(0, 12).map((n) => ({ quote_id: n.quote_id, status: n.status, round: n.round, rail: n.rail, request: n.request, accepted: n.accepted?.option || null, invoice_number: n.invoice?.invoice_number || null, charge: n.charge || null })),
      limits: limits.status(clientKey),
      price_edit_enabled: Boolean(config.adminToken),
      notices: { simulation: SIMULATION_NOTICE, low_balance: LOW_BALANCE_NOTICE },
      judge_refund_delay_ms: config.judge.autoRefundDelayMs,
      health: db.get('health', 'last'),
      refunds: db.list('refund_jobs').slice(-10).reverse(),
    })
  })
  // Price list edit (supplier owner). Needs the admin token; the page asks for it in the Price list tab.
  app.post('/api/price-list/:sku', (req, res, next) => {
    try {
      if (!config.adminToken || req.get('x-admin-token') !== config.adminToken) throw new HttpError(403, 'Owner token required to edit the price list', 'forbidden')
      const item = updatePriceItem(db, req.params.sku, req.body)
      events.emit('price_list_edited', { sku: item.sku })
      ok(res, { sku: item.sku, tiers: item.tiers, floor_cents: item.floor_cents, stock: item.stock, safety_stock: item.safety_stock, concession_bps: item.concession_bps, pay_now_bps: item.pay_now_bps })
    } catch (err) { next(err) }
  })
  app.get('/api/events', (req, res) => events.stream(req, res))
  app.get('/api/events/history', (req, res) => ok(res, events.all()))

  // ---- A person without a buyer agent: quote link and PayPal checkout ----
  app.post('/api/human-quote', (req, res, next) => {
    try {
      const body = parse(z.object({ sku: z.string().default('CUP-12-HOT'), qty: z.number().int().positive().max(100).default(2), client_key: z.string().max(80).default('anonymous') }), req.body)
      ok(res, createHumanQuote(ctx, { sku: body.sku, qty: body.qty, clientKey: body.client_key }), 201)
    } catch (err) { next(err) }
  })
  app.get('/q/:id', (req, res, next) => { try { res.send(quotePage(ctx, req.params.id)) } catch (err) { next(err) } })
  app.post('/q/:id/pay', async (req, res, next) => { try { res.redirect(await startHumanPayment(ctx, req.params.id)) } catch (err) { next(err) } })
  app.get('/q/:id/return', async (req, res, next) => { try { res.send(await finishHumanPayment(ctx, req.params.id)) } catch (err) { next(err) } })

  demoRoutes(app, ctx)

  // ---- Operator controls (token protected; disabled when no token is configured) ----
  const admin = (req, res, next) => {
    if (!config.adminToken || req.get('x-admin-token') !== config.adminToken) return next(new HttpError(403, 'Admin token required', 'forbidden'))
    next()
  }
  app.post('/admin/judge-balance', admin, (req, res, next) => {
    try {
      const { cents } = parse(z.object({ cents: z.number().int().nonnegative() }), req.body)
      limits.setBalance(cents)
      ok(res, limits.status('admin'))
    } catch (err) { next(err) }
  })
  app.post('/admin/run-refunds', admin, async (req, res, next) => {
    try { ok(res, await runDueRefunds({ db, config, paypalFor, limits, events })) } catch (err) { next(err) }
  })

  app.use((req, res, next) => next(new HttpError(404, 'Not found', 'not_found')))
  app.use(errorHandler)
  return { app, ctx }
}
