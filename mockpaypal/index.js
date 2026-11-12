import '../shared/env.js'
import { createMockPaypalApp } from './app.js'

const port = Number(process.env.MOCK_PAYPAL_PORT || 4103)
const app = createMockPaypalApp({
  baseUrl: process.env.MOCK_PAYPAL_URL || `http://localhost:${port}`,
  // PayPal documents up to 3 hours; the bundled mock waits 2 minutes by default so the demo path finishes.
  txnLagMs: Number(process.env.MOCK_TXN_LAG_MS || 120000),
  payerSeesCustomField: process.env.MOCK_PAYER_SEES_CUSTOM_FIELD !== '0',
  refundPending: process.env.MOCK_REFUND_PENDING === '1',
})
app.listen(port, () => console.log(`mock PayPal (no real money, no network) on :${port}`))
