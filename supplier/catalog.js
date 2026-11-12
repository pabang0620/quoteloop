import { money } from '../shared/money.js'
import { vaultFor } from './vault.js'

// Price list, floors, costs and stock live in the supplier's own database. Agents never set a price:
// they only pick among options the pricing engine produces from these numbers.
export const SEED_SKUS = [
  {
    sku: 'CUP-12-HOT', category: 'cups', name: '12oz hot cup, case of 1,000',
    tiers: [{ min: 1, price_cents: 14000 }, { min: 2, price_cents: 12800 }, { min: 3, price_cents: 11800 }],
    cost_cents: 8000, floor_cents: 11200, stock: 18, safety_stock: 6,
    concession_bps: [0, 200, 300], pay_now_bps: 200, base_terms: 'NET_30', upsell: true,
  },
  {
    sku: 'CUP-12-RECYCLED', category: 'cups', name: '12oz recycled-paper hot cup, case of 1,000',
    tiers: [{ min: 1, price_cents: 15200 }, { min: 2, price_cents: 13800 }, { min: 3, price_cents: 13000 }],
    cost_cents: 8600, floor_cents: 11800, stock: 10, safety_stock: 4,
    concession_bps: [0, 200, 300], pay_now_bps: 200, base_terms: 'NET_30', upsell: false,
  },
  {
    sku: 'GRN-BURR-64', category: 'equipment-parts', name: 'Grinder burr set, 64mm',
    tiers: [{ min: 1, price_cents: 118000 }],
    cost_cents: 80000, floor_cents: 105000, stock: 4, safety_stock: 1,
    concession_bps: [0, 0, 0], pay_now_bps: 0, base_terms: 'DUE_ON_RECEIPT', upsell: false,
  },
]

export function seedCatalog(db, force = false) {
  for (const item of SEED_SKUS) {
    if (force || !db.get('catalog', item.sku)) db.put('catalog', item.sku, { ...item })
  }
}

export const getItem = (db, sku) => db.get('catalog', sku)
export const listItems = (db) => db.list('catalog')

// Reservations made for judge-class buyers (the shared judge account and walk-in payers, whose sales are refunded)
// are not counted: one visitor's open quote must not change the concession another visitor is offered.
export function reservedFor(db, sku, excludeQuoteId, now = Date.now()) {
  return db.list('reservations', (r) => r.sku === sku && r.quote_id !== excludeQuoteId && r.expires_at > now && !r.judge).reduce((s, r) => s + r.qty, 0)
}

export const judgeClassBuyer = (db, buyerId) => String(buyerId).startsWith('human:') || vaultFor(db, buyerId)?.account_kind === 'judge'

// "Low stock" demo control: for one visitor only, a SKU shows fewer cases than the shared stock holds.
export const setDemoStock = (db, clientKey, doc) => (doc ? db.put('demo_stock', clientKey, doc) : db.del('demo_stock', clientKey))

export function availableStock(db, item, excludeQuoteId, { now = Date.now(), clientKey = null } = {}) {
  const demo = clientKey ? db.get('demo_stock', clientKey) : null
  const base = demo && demo.sku === item.sku ? Math.min(item.stock, demo.available) : item.stock
  return base - reservedFor(db, item.sku, excludeQuoteId, now)
}

// Operator reset: shared stock back to the seed numbers, no reservations, no visitor overrides.
export function resetCatalog(db) {
  for (const item of SEED_SKUS) db.put('catalog', item.sku, { ...item, ...(db.get('catalog', item.sku)?.paypal_product_id ? { paypal_product_id: db.get('catalog', item.sku).paypal_product_id } : {}) })
  for (const r of db.list('reservations')) db.del('reservations', r.quote_id)
  for (const row of db.dump().filter((x) => x.col === 'demo_stock')) db.del('demo_stock', row.id)
}

// Register each SKU as a PayPal catalog product (best effort: the demo runs without it).
export async function syncPaypalProducts(db, paypal, log = () => {}) {
  for (const item of listItems(db)) {
    if (item.paypal_product_id) continue
    try {
      const created = await paypal.createProduct({ name: item.name, description: `${item.sku} (${money(item.tiers[0].price_cents).value} list)`, type: 'PHYSICAL' })
      db.put('catalog', item.sku, { ...db.get('catalog', item.sku), paypal_product_id: created.id })
    } catch (err) {
      log(`catalog sync skipped for ${item.sku}: ${err.message}`)
    }
  }
}
