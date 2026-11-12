import { createMockPaypalApp } from '../mockpaypal/app.js'
import { createSupplierApp } from '../supplier/app.js'
import { createBuyerApp } from '../buyer/app.js'
import { loadSupplierConfig } from '../supplier/config.js'
import { autoConnectMock } from '../supplier/vault.js'
import { openDb } from '../shared/docdb.js'

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server))
})

// Three real HTTP servers in one test process: mock PayPal, supplier agent, buyer agent.
// They still talk only over HTTP with signed messages, exactly like the three production processes.
export async function startWorld({ supplier = {}, buyer = {}, mock = {}, judge = {}, connect = true, llm, supplierInjected } = {}) {
  const mockApp = createMockPaypalApp({ txnLagMs: 0, ...mock })
  const mockServer = await listen(mockApp)
  const mockBase = `http://127.0.0.1:${mockServer.address().port}`
  mockApp.state.cfg.baseUrl = mockBase

  const baseJudge = loadSupplierConfig().judge
  const s = createSupplierApp({ dbFile: ':memory:', keyFile: '', publicUrl: 'http://127.0.0.1:0', paypal: { ...loadSupplierConfig().paypal, mockBase, clientId: '', clientSecret: '' }, judge: { ...baseJudge, autoRefundDelayMs: 0, ...judge }, ...supplier }, { db: openDb(':memory:'), llm: llm?.supplier ?? null, ...(supplierInjected ? supplierInjected({ mockBase }) : {}) })
  const supplierServer = await listen(s.app)
  const supplierUrl = `http://127.0.0.1:${supplierServer.address().port}`
  s.ctx.config.publicUrl = supplierUrl

  const b = createBuyerApp({ dbFile: ':memory:', keyFile: '', supplierUrl, staticDir: 'no-such-dir', seedDemoHistory: false, paypal: { clientId: '', clientSecret: '', forceMock: false, mockBase, mockAccount: 'judge' }, ...buyer }, { db: openDb(':memory:'), llm: llm?.buyer ?? null })
  const buyerServer = await listen(b.app)
  const buyerUrl = `http://127.0.0.1:${buyerServer.address().port}`

  await b.ensureSupplier()
  if (connect) await autoConnectMock({ db: s.ctx.db, config: s.ctx.config, paypal: s.ctx.primary, buyerId: 'brightcup-cafes' })

  // Each caller is one visitor, identified by the cookie the server issues. A test names its visitor with client_key (or visitor).
  const call = async (base, method, path, body, extraHeaders = {}) => {
    const visitor = body?.visitor || body?.client_key || 'testvisitor'
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: `ql_visitor=${visitor}`, ...extraHeaders }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, ...json }
  }
  return {
    mock: mockApp.state, mockBase, supplier: s, buyer: b, supplierUrl, buyerUrl,
    runDeal: (body) => call(buyerUrl, 'POST', '/api/deals', { wait: true, ...body }),
    buyerApi: (method, path, body, headers) => call(buyerUrl, method, path, body, headers),
    supplierApi: (method, path, body, headers) => call(supplierUrl, method, path, body, headers),
    close: () => Promise.all([mockServer, supplierServer, buyerServer].map((srv) => new Promise((r) => srv.close(r)))),
  }
}
