// Loaded before every test file: a developer's .env with sandbox keys must never reach the tests.
process.env.FORCE_MOCK = '1'
for (const k of ['SUPPLIER_PAYPAL_CLIENT_ID', 'SUPPLIER_PAYPAL_CLIENT_SECRET', 'BUYER_PAYPAL_CLIENT_ID', 'BUYER_PAYPAL_CLIENT_SECRET', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'LLM_BACKEND']) process.env[k] = ''
