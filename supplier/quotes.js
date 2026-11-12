import { HttpError } from '../shared/http.js'
import { quoteHash } from '../shared/protocol.js'
import { availableStock, getItem, judgeClassBuyer } from './catalog.js'

const stripInternal = ({ floor_clamped, score_cents, ...option }) => option

export function nextQuoteId(db) {
  return db.tx(() => {
    const counter = db.get('counters', 'quote') || { n: 41 }
    const n = counter.n + 1
    db.put('counters', 'quote', { n })
    return `Q-${String(n).padStart(4, '0')}`
  })
}

export function startNegotiation(db, { buyerId, taskId, request, clientKey, mode }) {
  const neg = {
    quote_id: nextQuoteId(db), task_id: taskId, buyer_id: buyerId, request, client_key: clientKey, mode,
    round: 0, status: 'open', versions: [], accepted: null, invoice: null, created_at: new Date().toISOString(), rail: null,
  }
  db.put('negotiations', neg.quote_id, neg)
  return neg
}

export const getNegotiation = (db, quoteId) => {
  const neg = db.get('negotiations', quoteId)
  if (!neg) throw new HttpError(404, `Unknown quote ${quoteId}`, 'unknown_quote')
  return neg
}

// Turn priced options (from the pricing engine only) into a signed-ready quote version and reserve stock.
export function issueQuoteVersion(db, config, neg, pricedOptions, { note } = {}) {
  if (!pricedOptions.length) throw new HttpError(400, 'A quote needs at least one option', 'no_options')
  return db.tx(() => {
    const fresh = getNegotiation(db, neg.quote_id)
    if (fresh.status !== 'open') throw new HttpError(409, `Quote ${fresh.quote_id} is ${fresh.status}`, 'quote_closed')
    const version = fresh.versions.length + 1
    const now = Date.now()
    const options = pricedOptions.map((p, i) => {
      const label = String.fromCharCode(97 + i)
      const base = stripInternal(p)
      return { option_id: `${fresh.quote_id}-v${version}-${label}`, label, ...base, ...(p.substitute_for ? { substitute_for: p.substitute_for } : {}) }
    })
    // Stock check for every option, then reserve the largest one.
    for (const o of options) {
      const item = getItem(db, o.sku)
      if (o.qty > availableStock(db, item, fresh.quote_id, { now, clientKey: fresh.client_key })) throw new HttpError(409, `Not enough stock for ${o.sku}`, 'insufficient_stock')
    }
    const biggest = options.reduce((m, o) => (o.qty > m.qty ? o : m), options[0])
    db.put('reservations', fresh.quote_id, { quote_id: fresh.quote_id, sku: biggest.sku, qty: biggest.qty, expires_at: now + config.quoteTtlMs, judge: judgeClassBuyer(db, fresh.buyer_id) })
    const quote = {
      quote_id: fresh.quote_id, version, task_id: fresh.task_id, supplier_id: config.supplierId, buyer_id: fresh.buyer_id,
      currency: 'USD', options, issued_at: new Date(now).toISOString(), expires_at: new Date(now + config.quoteTtlMs).toISOString(),
      can_counter: version < config.maxRounds,
      pay_now_offered: options.some((o) => o.pay_now_available || o.pay_now),
      ...(note ? { note: note.slice(0, 400) } : {}),
    }
    db.put('negotiations', fresh.quote_id, { ...fresh, round: version, versions: [...fresh.versions, quote] })
    return quote
  })
}

export const latestQuote = (neg) => neg.versions.at(-1)

// Compare-and-set: the first valid ACCEPT wins; stock is held for the accepted quantity.
export function acceptQuote(db, config, { quoteId, optionId, hash }) {
  return db.tx(() => {
    const neg = getNegotiation(db, quoteId)
    if (neg.status !== 'open') throw new HttpError(409, `Quote ${quoteId} is already ${neg.status}`, 'quote_closed')
    const quote = latestQuote(neg)
    if (Date.parse(quote.expires_at) < Date.now()) {
      db.put('negotiations', quoteId, { ...neg, status: 'expired' })
      db.del('reservations', quoteId)
      throw new HttpError(409, 'Quote expired', 'quote_expired')
    }
    if (quoteHash(quote) !== hash) throw new HttpError(409, 'Quote changed since you read it', 'quote_hash_mismatch')
    const option = quote.options.find((o) => o.option_id === optionId)
    if (!option) throw new HttpError(404, 'Unknown option', 'unknown_option')
    db.put('reservations', quoteId, { quote_id: quoteId, sku: option.sku, qty: option.qty, expires_at: Date.now() + 30 * 60 * 1000, judge: judgeClassBuyer(db, neg.buyer_id) })
    const updated = { ...neg, status: 'accepted', accepted: { version: quote.version, option, quote_hash: hash, accepted_at: new Date().toISOString() } }
    db.put('negotiations', quoteId, updated)
    return updated
  })
}

export function cancelNegotiation(db, quoteId, status = 'cancelled') {
  return db.tx(() => {
    const neg = getNegotiation(db, quoteId)
    db.del('reservations', quoteId)
    db.put('negotiations', quoteId, { ...neg, status })
    return db.get('negotiations', quoteId)
  })
}

