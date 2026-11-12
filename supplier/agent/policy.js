import { HttpError } from '../../shared/http.js'
import { availableStock, getItem, listItems } from '../catalog.js'
import { upsellQty } from '../pricing.js'
import { createSession, supplierTools } from './tools.js'
import { runSupplierClaude } from './claude.js'

const toolMap = (tools) => Object.fromEntries(tools.map((t) => [t.name, t.run]))

// Deterministic supplier: same rules, no model. Option a = what was asked, option b = the next price tier up.
export function policyQuote(ctx, neg, { kind, request, option, levers }) {
  const round = neg.round + 1
  const session = createSession(neg, request, round)
  const run = toolMap(supplierTools(ctx, session))
  if (kind === 'rfq') {
    const item = getItem(ctx.db, request.sku)
    const stock = (i) => availableStock(ctx.db, i, neg.quote_id, { clientKey: neg.client_key })
    if (stock(item) < request.qty) {
      // Short of the requested item: offer the first same-category item that has enough cases, and say so.
      const sub = listItems(ctx.db).find((i) => i.sku !== item.sku && i.category === item.category && stock(i) >= request.qty)
      if (!sub) throw new HttpError(409, `Only ${stock(item)} cases of ${item.sku} are available`, 'insufficient_stock')
      const id = run.price_options({ sku: sub.sku, qty: request.qty }).price_option_id
      run.issue_quote({ price_option_ids: [id], note: `${item.name} is short right now, so this quote is for ${sub.name}.` })
    } else {
      const ids = [run.price_options({ sku: request.sku, qty: request.qty }).price_option_id]
      const up = upsellQty(item, request.qty, stock(item))
      if (up) ids.push(run.price_options({ sku: request.sku, qty: up }).price_option_id)
      run.issue_quote({ price_option_ids: ids })
    }
  } else {
    const id = run.price_options({ sku: option.sku, qty: option.qty, pay_now: Boolean(levers.pay_now) || option.pay_now }).price_option_id
    run.issue_quote({ price_option_ids: [id] })
  }
  return { quote: session.issued, decided_by: 'policy' }
}

export async function produceQuote(ctx, neg, args) {
  if (args.mode === 'claude' && ctx.llm) {
    const session = createSession(neg, args.request, neg.round + 1)
    const result = await runSupplierClaude(ctx, session, args)
    // The supplier model's moves for this round (tool names and amount-free inputs, its text, timings), for the log and recorded runs.
    ctx.events.emit('supplier_model_round', {
      quote_id: neg.quote_id, round: neg.round + 1, round_kind: args.kind, issued: Boolean(session.issued), text: String(result.text || '').slice(0, 2000), duration_ms: result.duration_ms ?? null,
      calls: result.calls.map((c) => ({ name: c.name, input: c.input, ok: c.ok, t_ms: c.t_ms ?? null })),
      steps: (result.steps || []).map((s) => (s.type === 'text' ? { t_ms: s.t_ms, type: 'text', text: String(s.text).slice(0, 2000) } : { t_ms: s.t_ms, type: 'tool', index: s.index })),
    })
    if (session.issued) return { quote: session.issued, decided_by: 'claude', note: result.text }
    ctx.events.emit('claude_fallback', { quote_id: neg.quote_id, reason: 'model issued no quote' })
  }
  try {
    return policyQuote(ctx, neg, args)
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(500, 'Could not price this request', 'pricing_failed')
  }
}
