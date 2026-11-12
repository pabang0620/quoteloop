import '../shared/env.js'

// Supplier service settings. Only SUPPLIER_* and shared PAYPAL_MOCK_* variables are read here.
const env = process.env
const num = (v, d) => (v === undefined || v === '' ? d : Number(v))

export function loadSupplierConfig(overrides = {}) {
  const port = num(env.SUPPLIER_PORT, 4102)
  return {
    port,
    supplierId: 'northbeam-supply',
    name: 'Northbeam Supply',
    email: 'sales@northbeam.example',
    publicUrl: (env.SUPPLIER_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    buyerUiUrl: (env.SUPPLIER_UI_RETURN_URL || 'http://localhost:4101').replace(/\/$/, ''),
    dbFile: env.SUPPLIER_DB_FILE || 'data/supplier.db',
    keyFile: env.SUPPLIER_KEY_FILE || 'data/supplier.key',
    keyPem: env.SUPPLIER_SIGNING_KEY || '',
    paypal: {
      clientId: env.SUPPLIER_PAYPAL_CLIENT_ID || '',
      clientSecret: env.SUPPLIER_PAYPAL_CLIENT_SECRET || '',
      forceMock: env.FORCE_MOCK === '1',
      mockBase: (env.MOCK_PAYPAL_URL || 'http://localhost:4103').replace(/\/$/, ''),
      vault: { usagePattern: env.PAYPAL_VAULT_USAGE_PATTERN, customerType: env.PAYPAL_VAULT_CUSTOMER_TYPE, storedCredential: env.PAYPAL_STORED_CREDENTIAL === '1' },
      presetVaultId: env.SUPPLIER_PRESET_VAULT_ID || '',
      presetVaultPayerEmail: env.SUPPLIER_PRESET_VAULT_PAYER_EMAIL || '',
    },
    anthropicKey: env.FORCE_MOCK === '1' ? '' : env.ANTHROPIC_API_KEY || '',
    // LLM_BACKEND=account runs the model through the developer's own Claude Code login (never an API key). Local use only.
    llmBackend: env.LLM_BACKEND === 'account' ? 'account' : 'api',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    // Per-charge ceiling the supplier's own code enforces before it charges a saved PayPal.
    perChargeLimitCents: num(env.SUPPLIER_PER_CHARGE_LIMIT_CENTS, 150000),
    quoteTtlMs: num(env.SUPPLIER_QUOTE_TTL_MS, 15 * 60 * 1000),
    maxRounds: 4,
    judge: {
      emails: (env.SUPPLIER_JUDGE_PAYER_EMAILS || 'judge-buyer@brightcup.example').split(',').map((s) => s.trim()).filter(Boolean),
      // Empty = 10 minutes on a real sandbox, 2 minutes on the bundled mock (resolved in app.js once the PayPal mode is known).
      autoRefundDelayMs: num(env.JUDGE_REFUND_DELAY_MS, null),
      startingBalanceCents: num(env.JUDGE_STARTING_BALANCE_CENTS, 1000000),
      minBalanceCents: num(env.JUDGE_MIN_BALANCE_CENTS, 150000),
      perClientPerDay: num(env.LIVE_CHARGES_PER_CLIENT_PER_DAY, 3),
      perDay: num(env.LIVE_CHARGES_PER_DAY, 60),
    },
    webhookId: env.SUPPLIER_PAYPAL_WEBHOOK_ID || '',
    adminToken: env.SUPPLIER_ADMIN_TOKEN || '',
    ...overrides,
  }
}
