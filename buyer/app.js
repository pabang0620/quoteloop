import express from 'express'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { createEventBus, errorHandler, HttpError, ok, parse } from '../shared/http.js'
import { openDb } from '../shared/docdb.js'
import { sha256hex, loadSigningKey } from '../shared/jws.js'
import { createGate } from '../shared/messages.js'
import { createPaypal } from '../shared/paypal.js'
import { createAnthropicClient, llmFromConfig, llmLabel } from '../shared/llm.js'
import { MSG } from '../shared/protocol.js'
import { mandateSchema } from '../shared/mandate.js'
import { auditActivity, auditState, resumeCosigning } from './audit.js'
import { createHealthCosign } from './cosign.js'
import { visitorOf } from './visitor.js'
import { loadRecordedRuns, loadSandboxEvidence } from './builtin.js'
import { loadBuyerConfig } from './config.js'
import { createDealsApi } from './deals.js'
import { budgetState, defaultMandates, getMandate, mandatesFor, resetBudgets, storeMandate } from './mandates.js'
import { parseRequestText } from './request.js'
import { runClaudeDeal, runPolicyDeal } from './agent/policy.js'
import { createSupplierClient } from './supplierClient.js'

export function createBuyerApp(overrides = {}, injected = {}) {
  const loaded = loadBuyerConfig(overrides)
  const db = injected.db || openDb(loaded.dbFile)
  const signer = injected.signer || loadSigningKey({ pem: loaded.keyPem, file: loaded.keyFile })
  const events = createEventBus()
  const paypal = injected.paypal || createPaypal({
    label: 'buyer', clientId: loaded.paypal.clientId, clientSecret: loaded.paypal.clientSecret, forceMock: loaded.paypal.forceMock,
    mockBase: loaded.paypal.mockBase, mockClientId: `mock-buyer-${loaded.paypal.mockAccount}-client`, mockClientSecret: `mock-buyer-${loaded.paypal.mockAccount}-secret`,
  })
  // On the bundled mock the activity delay is the mock's own (short) delay; on PayPal it is the documented 3 hours.
  const config = paypal.mode === 'mock' && overrides.searchLagMs === undefined ? { ...loaded, searchLagMs: loaded.mockSearchLagMs } : loaded
  const gate = createGate({ selfId: config.buyerId, signer, peerKey: (id) => db.get('peers', id)?.public_jwk || null })
  const supplier = createSupplierClient({ db, config, gate, signer, supplierUrl: config.supplierUrl })
  const llm = injected.llm !== undefined ? injected.llm : llmFromConfig({ backend: config.llmBackend, anthropicKey: config.anthropicKey, model: config.model })
  const ctx = { db, config, signer, gate, supplier, paypal, events, llm, card: null, supplierId: () => ctx.card?.supplier_id || 'northbeam-supply', supplierName: () => ctx.card?.name || 'Northbeam Supply' }
  const deals = createDealsApi(ctx)

  for (const m of defaultMandates(config)) if (!db.get('mandates', m.mandate_id)) storeMandate(db, m, signer)

  async function ensureSupplier() {
    if (ctx.card && ctx.registered) return ctx.card
    ctx.card = await supplier.discover(['northbeam-supply'])
    await supplier.register(ctx.card)
    ctx.registered = true
    return ctx.card
  }

  // Model runs are capped per visitor and per day so a public demo cannot burn through credits.
  function claudeBlocked(deal, now = Date.now()) {
    if (!ctx.llm) return 'No model key.'
    if (now >= config.llmLiveUntil) return 'The hackathon live window has ended.'
    const day = new Date(now).toISOString().slice(0, 10)
    const u = db.get('limits', `claude:${day}`) || { total: 0, per_client: {} }
    if (u.total >= config.claudePerDay) return 'Today\'s model runs are used up.'
    if ((u.per_client[deal.client_key] || 0) >= config.claudePerClientPerDay) return 'Your model runs for today are used up.'
    db.put('limits', `claude:${day}`, { total: u.total + 1, per_client: { ...u.per_client, [deal.client_key]: (u.per_client[deal.client_key] || 0) + 1 } })
    return null
  }

  async function execute(deal) {
    try {
      await ensureSupplier()
      const why = deal.mode === 'claude' ? claudeBlocked(deal) : null
      if (deal.mode === 'claude' && !why) {
        if (!ctx.llm.client && ctx.llm.backend !== 'account') ctx.llm.client = await createAnthropicClient(ctx.llm.key)
        try {
          await runClaudeDeal(ctx, deals, deal)
        } catch (err) {
          // The model call failed (no login, network, limit): carry on with the same tools run by rules, and say so.
          const fresh = db.get('deals', deal.deal_id) || deal
          if (!['negotiating', 'draft_received'].includes(fresh.status) || err instanceof HttpError) throw err
          events.emit('claude_unavailable', { deal_id: deal.deal_id, note: `The model call failed (${String(err.message).slice(0, 120)}). Running the same tools by rules.` })
          fresh.mode = 'policy'
          fresh.fell_back = true
          deals.save(fresh, 'deal_update')
          if (fresh.status === 'draft_received') await deals.settle(fresh)
          else await runPolicyDeal(ctx, deals, fresh)
        }
      } else {
        if (deal.mode === 'claude') {
          deal.mode = 'policy'
          events.emit('claude_unavailable', { deal_id: deal.deal_id, note: `${why} Running the same rules in policy mode.` })
        }
        await runPolicyDeal(ctx, deals, deal)
      }
    } catch (err) {
      const fresh = db.get('deals', deal.deal_id) || deal
      if (!['paid', 'blocked', 'awaiting_approval', 'invoiced_net30'].includes(fresh.status)) {
        fresh.status = 'failed'
        fresh.error = err.message
        deals.save(fresh, 'deal_failed', { error: err.message })
      }
    }
    return db.get('deals', deal.deal_id)
  }

  // Whose request this is comes from the server-issued cookie; a client_key in the body or query is ignored.
  const networkKeyOf = (req) => `ip:${sha256hex(req.ip || '')}`.slice(0, 20)
  const MAX_CUSTOM_BUDGET_CENTS = 500000

  async function runDailyCheck() {
    await ensureSupplier()
    const cosign = createHealthCosign({ db, config, signer, payeeId: ctx.supplierId() })
    const reply = await supplier.send(MSG.HEALTH_CHECK, 'health', { cosign_jws: cosign.jws }, ctx.supplierId())
    db.put('cosigns', cosign.cosign_hash, { ...cosign, state: reply.body.ok ? 'charged' : 'unused', charged_at: new Date().toISOString() })
    return reply.body
  }

  const adminOnly = (req, res, next) => {
    if (!config.adminToken || req.get('x-admin-token') !== config.adminToken) return next(new HttpError(403, 'Admin token required', 'forbidden'))
    next()
  }

  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.set('Access-Control-Allow-Origin', '*')
    next()
  })

  app.get('/.well-known/agent-card.json', (req, res) => res.json({ name: `${config.company} procurement agent`, buyer_id: config.buyerId, kid: signer.kid, public_jwk: signer.publicJwk, role: 'buyer' }))
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'buyer', paypal: paypal.mode }))

  app.get('/api/me', (req, res) => ok(res, { visitor: visitorOf(req, res) }))

  app.get('/api/state', async (req, res, next) => {
    try {
      const visitor = visitorOf(req, res)
      await deals.syncRefunds(visitor).catch(() => 0)
      let vault = null
      try {
        await ensureSupplier()
        const reply = await supplier.send(MSG.VAULT_STATUS, 'status', { client_key: visitorOf(req, res) }, ctx.supplierId())
        vault = reply.body
      } catch { vault = null }
      const mandates = mandatesFor(db, visitor).map(({ mandate }) => ({ ...mandate, budget_state: budgetState(db, mandate, visitor) }))
      ok(res, {
        buyer: { id: config.buyerId, company: config.company, admin: config.admin, paypal_mode: paypal.mode, kid: signer.kid },
        llm_available: Boolean(ctx.llm),
        search_lag_ms: config.searchLagMs,
        llm_label: llmLabel(ctx.llm),
        visitor,
        supplier: ctx.card ? { id: ctx.card.supplier_id, name: ctx.card.name, kid: ctx.card.kid } : null,
        supplier_public_url: config.supplierPublicUrl,
        vault,
        mandates,
        deals: db.list('deals', (d) => d.client_key === visitor).slice(-20).reverse(),
        approvals: db.list('approvals', (x) => x.client_key === visitor).slice(-10).reverse(),
        audit: { state: auditState(db, visitor), last: db.get('state', `audit_last:${visitor}`) },
        cosigns: db.list('cosigns', (c) => !c.visitor || c.visitor === visitor).slice(-15).reverse().map(({ jws, ...c }) => c),
      })
    } catch (err) { next(err) }
  })

  app.post('/api/deals', async (req, res, next) => {
    try {
      const visitor = visitorOf(req, res)
      await deals.syncRefunds(visitor).catch(() => 0)
      const body = parse(z.object({
        mandate_id: z.string().max(60).default('MND-A-LEAN'),
        text: z.string().trim().min(3).max(200).optional(),
        sku: z.string().optional(), qty: z.number().int().positive().max(1000).optional(), need_by: z.string().max(40).optional(),
        mode: z.enum(['policy', 'claude']).default('policy'),
        wait: z.boolean().default(false),
      }), req.body)
      const request = body.sku && body.qty ? { sku: body.sku, qty: body.qty, need_by: body.need_by } : parseRequestText(body.text || '12oz hot cups, 2 cases, by Friday')
      // Claude mode reads the sentence itself; the parsed fields are only the starting point the page shows.
      const requestText = body.mode === 'claude' && !(body.sku && body.qty) && body.text ? body.text : null
      const deal = deals.startDeal({ mandateId: body.mandate_id, request, mode: body.mode, clientKey: visitor, networkKey: networkKeyOf(req), requestText })
      const running = execute(deal)
      if (body.wait) return ok(res, await running, 201)
      return ok(res, deal, 201)
    } catch (err) { next(err) }
  })
  app.get('/api/deals/:id', (req, res, next) => {
    try {
      const deal = db.get('deals', req.params.id)
      if (!deal || deal.client_key !== visitorOf(req, res)) throw new HttpError(404, 'Unknown deal', 'unknown_deal')
      ok(res, deal)
    } catch (err) { next(err) }
  })

  app.post('/api/approvals/:id/:decision', async (req, res, next) => {
    try {
      if (!['approve', 'reject'].includes(req.params.decision)) throw new HttpError(400, 'decision must be approve or reject', 'invalid_input')
      const approval = db.get('approvals', req.params.id)
      if (approval && db.get('deals', approval.deal_id)?.client_key !== visitorOf(req, res)) throw new HttpError(404, 'No pending approval with that id', 'unknown_approval')
      ok(res, await deals.resolveApproval(req.params.id, req.params.decision))
    } catch (err) { next(err) }
  })

  app.post('/api/audit/run', async (req, res, next) => {
    try { ok(res, await auditActivity({ db, paypal, config, visitor: visitorOf(req, res) })) } catch (err) { next(err) }
  })
  app.post('/api/audit/resume', (req, res) => ok(res, resumeCosigning(db, visitorOf(req, res))))

  // Daily check of the saved PayPal: the buyer agent co-signs the one-dollar charge, then asks the supplier to run it.
  app.post('/admin/daily-check', adminOnly, async (req, res, next) => {
    try { ok(res, await runDailyCheck()) } catch (err) { next(err) }
  })

  // Operator reset of the demo: every visitor's budget, deals, approvals and audit state.
  app.post('/admin/reset-demo', adminOnly, (req, res, next) => {
    try {
      resetBudgets(db)
      for (const col of ['deals', 'approvals']) for (const row of db.dump().filter((r) => r.col === col)) db.del(col, row.id)
      for (const row of db.dump().filter((r) => r.col === 'state' && /^audit/.test(r.id))) db.del('state', row.id)
      for (const row of db.dump().filter((r) => r.col === 'mandates' && JSON.parse(r.body).visitor)) db.del('mandates', row.id)
      ok(res, { reset: true })
    } catch (err) { next(err) }
  })

  app.post('/api/vault/connect', async (req, res, next) => {
    try {
      await ensureSupplier()
      const reply = await supplier.send(MSG.VAULT_SETUP, 'vault', {}, ctx.supplierId())
      ok(res, reply.body)
    } catch (err) { next(err) }
  })

  app.post('/api/mandates/custom', (req, res, next) => {
    try {
      const body = parse(z.object({
        unit_cap_cents: z.number().int().positive(), reference_unit_cents: z.number().int().positive(),
        max_overorder_pct: z.number().int().min(0).max(500), auto_approve_cents: z.number().int().positive(), budget_cents: z.number().int().positive().max(MAX_CUSTOM_BUDGET_CENTS),
      }), req.body)
      const visitor = visitorOf(req, res)
      const base = getMandate(db, 'MND-A-LEAN').mandate
      const custom = mandateSchema.parse({
        ...base, mandate_id: `MND-CUSTOM-${visitor}`.slice(0, 40), label: 'Custom',
        checkout: { ...base.checkout, line_items: base.checkout.line_items.map((l) => (l.sku === 'CUP-12-HOT' ? { ...l, unit_cap_cents: body.unit_cap_cents, reference_unit_cents: body.reference_unit_cents } : l)) },
        payment: { ...base.payment, budget: { ...base.payment.budget, total_cents: body.budget_cents } },
        negotiation: { ...base.negotiation, max_overorder_pct: body.max_overorder_pct, auto_approve_cents: body.auto_approve_cents },
      })
      storeMandate(db, custom, signer, { visitor })
      ok(res, custom, 201)
    } catch (err) { next(err) }
  })

  app.get('/api/compare', (req, res) => {
    const visitor = visitorOf(req, res)
    const paid = db.list('deals', (d) => d.status === 'paid' && d.accepted && !d.history && d.client_key === visitor && d.request?.sku === 'CUP-12-HOT')
    const pick = (id) => {
      const d = paid.filter((x) => x.mandate_id === id).at(-1)
      if (!d) return null
      const o = d.accepted.option
      return { mandate_id: id, deal_id: d.deal_id, sku: o.sku, qty: o.qty, total_cents: o.total_cents, net_unit_cents: o.net_unit_cents, rounds: d.rounds.length, round1_accept_total_cents: d.round1_accept_total_cents, saved_cents: d.saved_cents || 0 }
    }
    ok(res, { a: pick('MND-A-LEAN'), b: pick('MND-B-BULK') })
  })

  // Saved real model runs and the sandbox results, shipped with the app (read once at start).
  const recordedRuns = injected.recordedRuns || loadRecordedRuns()
  const sandboxEvidence = injected.sandboxEvidence !== undefined ? injected.sandboxEvidence : loadSandboxEvidence()
  app.get('/api/recorded-runs', (req, res) => ok(res, { runs: recordedRuns }))
  app.get('/api/sandbox-evidence', (req, res) => ok(res, sandboxEvidence))

  app.get('/api/events', (req, res) => events.stream(req, res))
  app.get('/api/events/history', (req, res) => ok(res, events.all()))

  const dist = resolve(config.staticDir)
  if (existsSync(dist)) {
    app.use(express.static(dist))
    app.get(/^\/(?!api\/|\.well-known\/).*/, (req, res) => res.sendFile(resolve(dist, 'index.html')))
  }
  app.use((req, res, next) => next(new HttpError(404, 'Not found', 'not_found')))
  app.use(errorHandler)
  return { app, ctx, deals, ensureSupplier, execute, runDailyCheck }
}
