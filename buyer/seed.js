import { postJson } from '../shared/http.js'

// Mock mode only: yesterday's deal Q-0041, so the PayPal activity tab shows a matched and refunded charge
// next to today's pending one. The matching records go into the buyer's own database and the mock PayPal.
export async function seedDemoHistory({ db, config, paypal }) {
  if (paypal.mode !== 'mock' || !config.seedDemoHistory) return false
  const yesterday = Date.now() - 26 * 3600 * 1000
  const hash = 'seed-yesterday-q0041-cosign-hash-0000000000'
  const captureId = 'SEEDCAPTURE0041XX'
  db.put('cosigns', hash, { cosign_hash: hash, jws: 'seeded', v: 1, payee: 'northbeam-supply', amount: '245.86', currency: 'USD', invoice_number: 'INV-0041', quote_id: 'Q-0041', quote_hash: 'seed', mandate_id: 'MND-A-LEAN', nonce: 'seeded', exp: Math.floor(yesterday / 1000) + 600, state: 'charged', capture_id: captureId, created_at: new Date(yesterday).toISOString(), history: true })
  const acct = config.paypal.mockAccount
  const body = (payload) => postJson(`${config.paypal.mockBase}/mock/seed-transaction`, { account: acct, ...payload })
  await body({ id: captureId, amount: '-245.86', invoiceId: 'INV-0041', customId: hash, at: new Date(yesterday).toISOString() })
  await body({ id: 'SEEDREFUND0041XXX', amount: '245.86', code: 'T1107', invoiceId: 'INV-0041', ref: captureId, at: new Date(yesterday + 11 * 60000).toISOString() })
  // Yesterday's $19.99 charge that carries no co-signature: the first Check raises the alert card.
  await body({ id: 'SEEDROGUE0040XXXX', amount: '-19.99', invoiceId: 'INV-ROGUE-SEED', customId: 'supplier-did-not-ask', at: new Date(yesterday + 3600000).toISOString() })
  return true
}
