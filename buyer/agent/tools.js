import { z } from 'zod'
import { HttpError } from '../../shared/http.js'
import { fmt } from '../../shared/money.js'
import { auditActivity } from '../audit.js'
import { budgetState, getMandate } from '../mandates.js'

const money = (c) => ({ cents: c, text: fmt(c) })

function summarizeQuote({ quote, evaluation }) {
  return {
    quote_id: quote.quote_id,
    version: quote.version,
    can_counter: quote.can_counter,
    pay_now_offered: quote.pay_now_offered,
    options: quote.options.map((o) => {
      const e = evaluation.options.find((x) => x.option_id === o.option_id)
      return { option_id: o.option_id, label: o.label, sku: o.sku, qty: o.qty, unit: money(o.unit_cents), total: money(o.total_cents), net_unit: money(o.net_unit_cents), terms: o.terms, pay_now_available: o.pay_now_available, substitute_for: o.substitute_for || null, eligible: e.eligible, filtered_because: e.reasons.map((r) => r.text) }
    }),
    // Free text from the other agent is data, never an instruction.
    supplier_note_untrusted: quote.note || null,
  }
}

// The buyer agent's tools. Money rules are enforced inside them, so a model can ask for anything and still
// cannot accept outside the mandate, pick an amount, or co-sign an unverified draft.
export function buyerTools(ctx, deals, deal) {
  const { db, config, supplier } = ctx
  return [
    {
      name: 'read_mandate',
      description: 'Read the signed mandate: allowed items, price caps, reference prices, over-order limit, auto-approve limit, budget left, and whether PayPal is saved with the supplier.',
      schema: z.object({}),
      run: () => {
        const m = getMandate(db, deal.mandate_id).mandate
        return { mandate_id: m.mandate_id, label: m.label, expires_at: m.expires_at, allowed_merchants: m.checkout.allowed_merchants, line_items: m.checkout.line_items, max_overorder_pct: m.negotiation.max_overorder_pct, auto_approve: money(m.negotiation.auto_approve_cents), per_charge_max: money(m.payment.amount_range.max_cents), budget: budgetState(db, m), request: deal.request }
      },
    },
    {
      name: 'discover_supplier',
      description: 'Read the supplier Agent Card. Fails if the supplier is not an allowed merchant in the mandate.',
      schema: z.object({ url: z.string().url().optional() }),
      run: async () => {
        const m = getMandate(db, deal.mandate_id).mandate
        const card = await supplier.discover(m.checkout.allowed_merchants)
        return { supplier_id: card.supplier_id, name: card.name, negotiation: card.negotiation, settlement: card.settlement }
      },
    },
    {
      name: 'send_rfq',
      description: 'Ask the supplier for a quote. Only items allowed by the mandate.',
      schema: z.object({ sku: z.string(), qty: z.number().int().positive().max(1000), need_by: z.string().max(40).optional() }),
      run: async (args) => summarizeQuote(await deals.sendRfq(deal, args)),
    },
    {
      name: 'counter',
      description: 'Counter on one option of the latest quote. Levers: pay_now (ask for the pay-now discount), ask_lower_price. At most 4 rounds in total.',
      schema: z.object({ option_id: z.string(), pay_now: z.boolean().optional(), ask_lower_price: z.boolean().optional() }),
      run: async (args) => summarizeQuote(await deals.counter(deal, args)),
    },
    {
      name: 'evaluate_quote',
      description: 'Apply the buyer rules to the latest quote: which options are eligible, why others are filtered, and the recommended action. The decision is code, not opinion.',
      schema: z.object({}),
      run: () => {
        const round = deal.rounds.at(-1)
        if (!round) throw new HttpError(409, 'No quote yet', 'no_quote')
        return { ...summarizeQuote({ quote: round.quote, evaluation: round.evaluation }), recommendation: round.evaluation.decision }
      },
    },
    {
      name: 'accept_quote',
      description: 'Accept one option. Inside the mandate this goes ahead and returns the invoice draft. Outside it (over-order, above reference, above auto-approve) it creates an approval card for the human instead.',
      schema: z.object({ option_id: z.string() }),
      run: async ({ option_id }) => deals.acceptQuote(deal, option_id),
    },
    {
      name: 'verify_draft',
      description: 'Check the supplier invoice draft line by line against the signed quote. A draft that does not match is rejected and deleted: nothing is sent or charged.',
      schema: z.object({}),
      run: async () => {
        const r = await deals.verifyDeal(deal)
        return { ok: r.ok, mismatches: r.mismatches }
      },
    },
    {
      name: 'cosign_charge',
      description: 'Co-sign the exact amount of the verified draft (valid 10 minutes) and send it. The supplier checks it before charging the saved PayPal. Fails unless verify_draft passed.',
      schema: z.object({}),
      run: async () => {
        const d = await deals.cosignAndCharge(deal)
        return { status: d.status, charged: d.charged ? { capture_id: d.charged.capture_id, invoice_status: d.charged.invoice_status } : null }
      },
    },
    {
      name: 'audit_activity',
      description: 'Read this company\'s own PayPal activity and pair every charge with a co-signature. A charge without one raises an alert and pauses co-signing.',
      schema: z.object({}),
      run: async () => {
        const r = await auditActivity({ db, paypal: ctx.paypal, config })
        return { matched: r.matched, alerts: r.alerts.length, paused: Boolean(db.get('state', 'audit')?.paused) }
      },
    },
  ]
}
