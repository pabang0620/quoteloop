import '../shared/env.js'

// Buyer service settings. Only BUYER_* and shared PAYPAL_MOCK_* variables are read here.
const env = process.env
const num = (v, d) => (v === undefined || v === '' ? d : Number(v))

export function loadBuyerConfig(overrides = {}) {
  const port = num(env.BUYER_PORT, 4101)
  const mockAccount = env.BUYER_MOCK_ACCOUNT === 'procurement' ? 'procurement' : 'judge'
  return {
    port,
    buyerId: 'brightcup-cafes',
    company: 'Brightcup Cafes',
    admin: 'Maya Chen',
    billingEmail: 'ap@brightcup.example',
    publicUrl: (env.BUYER_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    supplierUrl: (env.BUYER_SUPPLIER_URL || 'http://localhost:4102').replace(/\/$/, ''),
    supplierPublicUrl: (env.BUYER_SUPPLIER_PUBLIC_URL || env.BUYER_SUPPLIER_URL || 'http://localhost:4102').replace(/\/$/, ''),
    supplierKeyPin: env.BUYER_SUPPLIER_KID_PIN || '',
    dbFile: env.BUYER_DB_FILE || 'data/buyer.db',
    keyFile: env.BUYER_KEY_FILE || 'data/buyer.key',
    keyPem: env.BUYER_SIGNING_KEY || '',
    paypal: {
      clientId: env.BUYER_PAYPAL_CLIENT_ID || '',
      clientSecret: env.BUYER_PAYPAL_CLIENT_SECRET || '',
      forceMock: env.FORCE_MOCK === '1',
      mockBase: (env.MOCK_PAYPAL_URL || 'http://localhost:4103').replace(/\/$/, ''),
      mockAccount,
    },
    anthropicKey: env.FORCE_MOCK === '1' ? '' : env.ANTHROPIC_API_KEY || '',
    // LLM_BACKEND=account runs the model through the developer's own Claude Code login (never an API key). Local use only.
    llmBackend: env.LLM_BACKEND === 'account' ? 'account' : 'api',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    adminToken: env.BUYER_ADMIN_TOKEN || '',
    cosignTtlSec: 600,
    // PayPal documents up to 3 hours before a charge shows in Transaction Search. The bundled mock waits MOCK_TXN_LAG_MS (2 minutes by default).
    searchLagMs: 3 * 60 * 60 * 1000,
    mockSearchLagMs: num(env.MOCK_TXN_LAG_MS, 2 * 60 * 1000),
    staticDir: env.BUYER_STATIC_DIR || 'dist',
    claudePerClientPerDay: num(env.CLAUDE_RUNS_PER_CLIENT_PER_DAY, 5),
    claudePerDay: num(env.CLAUDE_RUNS_PER_DAY, 100),
    // Paid model keys stop with the hackathon results; the date is in code on purpose so a missing env value cannot extend it.
    llmLiveUntil: Date.parse(env.LLM_LIVE_UNTIL || '2026-12-22T00:00:00+09:00'),
    seedDemoHistory: env.BUYER_SEED_HISTORY !== '0',
    // payer = the buyer app belongs to the paying account (the real setup). payee = sandbox demo with only the supplier's REST app.
    activitySide: env.BUYER_ACTIVITY_SIDE === 'payee' ? 'payee' : 'payer',
    ...overrides,
  }
}
