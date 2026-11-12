import { z } from 'zod'
import { HttpError, parse } from '../shared/http.js'

const cents = z.number().int().positive().max(10_000_000)
const bps = z.number().int().min(0).max(1500)

export const priceListUpdate = z.object({
  tiers: z.array(z.object({ min: z.number().int().positive().max(1000), price_cents: cents })).min(1).max(6).optional(),
  floor_cents: cents.optional(),
  stock: z.number().int().min(0).max(100000).optional(),
  safety_stock: z.number().int().min(0).max(100000).optional(),
  concession_bps: z.array(bps).length(3).optional(),
  pay_now_bps: bps.optional(),
}).strict()

// The owner edits numbers; the rules that keep the supplier from selling under cost live here, in code.
export function updatePriceItem(db, sku, body) {
  const item = db.get('catalog', sku)
  if (!item) throw new HttpError(404, 'Unknown SKU', 'unknown_sku')
  const patch = parse(priceListUpdate, body)
  const next = { ...item, ...patch }
  const tiers = next.tiers
  if (tiers[0].min !== 1) throw new HttpError(400, 'The first price tier must start at 1 case', 'bad_tiers')
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i].min <= tiers[i - 1].min) throw new HttpError(400, 'Tier quantities must increase', 'bad_tiers')
    if (tiers[i].price_cents > tiers[i - 1].price_cents) throw new HttpError(400, 'A bigger quantity cannot cost more per case', 'bad_tiers')
  }
  if (next.floor_cents < item.cost_cents) throw new HttpError(400, 'The floor price cannot be under the supplier cost', 'floor_under_cost')
  if (tiers.some((t) => t.price_cents < next.floor_cents)) throw new HttpError(400, 'A tier price cannot be under the floor price', 'tier_under_floor')
  if (next.safety_stock > next.stock) throw new HttpError(400, 'Safety stock cannot be above stock', 'bad_stock')
  db.put('catalog', sku, next)
  return next
}
