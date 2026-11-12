import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`${url} did not start`)
}

test('three separate OS processes (mock PayPal, supplier, buyer) run a deal end to end over HTTP', async () => {
  const [mockPort, supplierPort, buyerPort] = await Promise.all([freePort(), freePort(), freePort()])
  const dir = join(root, '.scratch', `proc-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const env = {
    PATH: process.env.PATH, FORCE_MOCK: '1', NODE_ENV: 'test',
    MOCK_PAYPAL_PORT: String(mockPort), MOCK_PAYPAL_URL: `http://127.0.0.1:${mockPort}`, MOCK_TXN_LAG_MS: '10800000',
    SUPPLIER_PORT: String(supplierPort), SUPPLIER_PUBLIC_URL: `http://127.0.0.1:${supplierPort}`,
    SUPPLIER_DB_FILE: join(dir, 'supplier.db'), SUPPLIER_KEY_FILE: join(dir, 'supplier.key'),
    BUYER_PORT: String(buyerPort), BUYER_SUPPLIER_URL: `http://127.0.0.1:${supplierPort}`,
    BUYER_DB_FILE: join(dir, 'buyer.db'), BUYER_KEY_FILE: join(dir, 'buyer.key'), BUYER_STATIC_DIR: join(dir, 'none'),
  }
  const spawnOne = (file) => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { cwd: root, env, stdio: 'ignore' })
  const children = [spawnOne('mockpaypal/index.js'), spawnOne('supplier/index.js'), spawnOne('buyer/index.js')]
  try {
    assert.equal(new Set(children.map((c) => c.pid)).size, 3)
    await Promise.all([`http://127.0.0.1:${mockPort}/mock/health`, `http://127.0.0.1:${supplierPort}/api/health`, `http://127.0.0.1:${buyerPort}/api/health`].map((u) => waitFor(u)))
    const buyer = `http://127.0.0.1:${buyerPort}`
    // The supplier connects the demo judge account on start-up; wait until the buyer sees it.
    const end = Date.now() + 15000
    let state
    while (Date.now() < end) {
      state = (await (await fetch(`${buyer}/api/state`, { headers: { Cookie: 'ql_visitor=procvisitor' } })).json()).data
      if (state.vault?.connected) break
      await new Promise((r) => setTimeout(r, 300))
    }
    assert.equal(state.vault.connected, true)
    assert.equal(state.vault.account_kind, 'judge')
    const run = async (mandate) => (await (await fetch(`${buyer}/api/deals`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'ql_visitor=procvisitor' }, body: JSON.stringify({ mandate_id: mandate, text: '12oz hot cups, 2 cases, by Friday', wait: true }) })).json()).data
    const a = await run('MND-A-LEAN')
    assert.equal(a.status, 'paid')
    assert.equal(a.accepted.option.total_cents, 24586)
    const b = await run('MND-B-BULK')
    assert.equal(b.accepted.option.total_cents, 33998)
    assert.equal(b.saved_cents, 1402)
    // Yesterday's seeded deal is matched and refunded in the buyer's PayPal records; today's are still pending (3h lag).
    const audit = (await (await fetch(`${buyer}/api/audit/run`, { method: 'POST', headers: { Cookie: 'ql_visitor=procvisitor' } })).json()).data
    const yesterday = audit.rows.find((r) => r.invoice_id === 'INV-0041' && r.kind === 'charge')
    assert.deepEqual([yesterday.status, yesterday.refunded], ['matched', true])
    assert.equal(audit.rows.filter((r) => r.status === 'pending').length, 2)
    assert.equal(audit.alerts.length, 1, 'the seeded unsigned $19.99 charge of yesterday')
    assert.equal(audit.alerts[0].amount, -19.99)
  } finally {
    for (const c of children) c.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})
