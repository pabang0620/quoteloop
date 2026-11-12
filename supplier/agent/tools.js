import { z } from 'zod'
import { HttpError } from '../../shared/http.js'
import { availableStock, getItem, listItems } from '../catalog.js'
import { priceOption } from '../pricing.js'
import { issueQuoteVersion } from '../quotes.js'

// The supplier agent's tools. Prices come only from the pricing engine (price list, concession schedule, floor).
// A model can pick among priced options; it cannot type a price.
export function createSession(neg, request, round) {
  return { neg, request, round, priced: new Map(), issued: null, counter: 0 }
}

export function supplierTools(ctx, session) {
  const { db, config } = ctx
  const requestedItem = () => getItem(db, session.request.sku)
  return [
    {
      name: 'list_catalog',
      description: 'List what the supplier sells: sku, category, price tiers per case, stock available now, and whether a pay-now discount exists.',
      schema: z.object({}),
      run: () => listItems(db).map((i) => ({ sku: i.sku, category: i.category, name: i.name, tiers: i.tiers, available_cases: availableStock(db, i, session.neg.quote_id, { clientKey: session.neg.client_key }), safety_stock_cases: i.safety_stock, pay_now_discount: i.pay_now_bps > 0 })),
    },
    {
      name: 'price_options',
      description: 'Price one line for this negotiation round. The price list, this round\'s concession and the floor are applied by code. A substitute must be in the same category as the requested sku.',
      schema: z.object({ sku: z.string(), qty: z.number().int().positive().max(1000), pay_now: z.boolean().optional() }),
      run: ({ sku, qty, pay_now }) => {
        const item = getItem(db, sku)
        if (!item) throw new HttpError(404, `Unknown sku ${sku}`, 'unknown_sku')
        if (item.category !== requestedItem().category) throw new HttpError(400, 'A substitute must be in the same category', 'category_mismatch')
        const available = availableStock(db, item, session.neg.quote_id, { clientKey: session.neg.client_key })
        if (qty > available) throw new HttpError(409, `Only ${available} cases of ${sku} are available`, 'insufficient_stock')
        const priced = priceOption(item, { qty, round: session.round, payNow: Boolean(pay_now), availableCases: available })
        const id = `po_${session.priced.size + 1}`
        session.priced.set(id, { ...priced, ...(sku !== session.request.sku ? { substitute_for: session.request.sku } : {}) })
        return { price_option_id: id, sku, qty, unit_cents: priced.unit_cents, total_cents: priced.total_cents, net_unit_cents: priced.net_unit_cents, terms: priced.terms, pay_now_applied: priced.pay_now, score_cents: priced.score_cents, substitute: sku !== session.request.sku }
      },
    },
    {
      name: 'issue_quote',
      description: 'Send the buyer a quote made only of options returned by price_options. You cannot change a price here.',
      schema: z.object({ price_option_ids: z.array(z.string()).min(1).max(3), note: z.string().max(300).optional() }),
      run: ({ price_option_ids, note }) => {
        if (session.issued) throw new HttpError(409, 'A quote was already issued for this request', 'already_issued')
        const options = price_option_ids.map((id) => {
          const o = session.priced.get(id)
          if (!o) throw new HttpError(400, `Unknown price option ${id}`, 'unknown_price_option')
          return o
        })
        session.issued = issueQuoteVersion(db, config, session.neg, options, { note })
        return { quote_id: session.issued.quote_id, version: session.issued.version, options: session.issued.options.map((o) => ({ option_id: o.option_id, sku: o.sku, qty: o.qty, total_cents: o.total_cents })) }
      },
    },
  ]
}
