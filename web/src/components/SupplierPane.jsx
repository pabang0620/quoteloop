import { usd } from '../api.js'

export default function SupplierPane({ state, deal, events }) {
  const quoteId = deal?.quote_id
  const mine = events.filter((e) => e.quote_id === quoteId)
  const hot = state?.catalog.find((c) => c.sku === (deal?.request.sku || 'CUP-12-HOT')) || state?.catalog[0]
  const quotes = mine.filter((e) => e.kind === 'quote_issued')
  const draft = mine.find((e) => e.kind === 'draft_created')
  const charged = mine.find((e) => e.kind === 'charged')
  const paid = mine.find((e) => e.kind === 'paid')
  const refund = mine.find((e) => e.kind === 'judge_refund')
  const rejected = mine.find((e) => e.kind === 'draft_rejected')
  const pc = (bps) => `${bps / 100}%`
  return (
    <section className="pane">
      <h2>Northbeam Supply <small>supplier service</small></h2>
      {hot && (
        <div className="chips">
          <span className="chip">{hot.name}</span>
          <span className="chip">floor {usd(hot.floor_cents)}</span>
          <span className="chip">stock {hot.available ?? hot.stock} cases</span>
          <span className="chip">concession {hot.concession_bps.map(pc).join(' / ')}</span>
          <span className="chip">pay-now {pc(hot.pay_now_bps)}</span>
        </div>
      )}
      <p className="saved">Per-charge limit {state ? usd(state.supplier.per_charge_limit_cents) : ''} (enforced by supplier code, audited by buyer agent). PayPal: {state?.supplier.paypal_mode}.</p>
      {!deal && <p className="empty">Waiting for a request.</p>}
      {quotes.map((q) => (
        <div className="round" key={q.version}>
          <div className="rhead"><b>R{q.version}</b> QUOTE <span className={`badge ${q.decided_by === 'claude' ? 'claude' : ''}`}>{q.decided_by === 'claude' ? 'Claude chose this, no rule scripted it' : 'rules'}</span></div>
          {q.options.map((o) => (
            <div className="opt" key={o.label}>
              <span>{o.label}: {o.qty} x {usd(o.unit_cents)}{o.pay_now ? ' + pay-now' : ''} = {usd(o.total_cents)} <small>{o.terms}</small>{o.substitute_for ? ` (substitute for ${o.substitute_for})` : ''}</span>
              <span className="okk">score {usd(o.score_cents)}</span>
            </div>
          ))}
        </div>
      ))}
      {draft && <div className="step">DRAFT {draft.invoice_number} (PayPal) signed copy sent to the buyer</div>}
      {rejected && <div className="step bad">Draft deleted after the buyer's check. Nothing sent, nothing charged.</div>}
      {charged && <div className="step">CHARGE saved PayPal: order COMPLETED, capture {charged.capture_id}</div>}
      {paid && <div className="step">{paid.invoice_number} {paid.invoice_status} (capture recorded). Stock now {paid.stock_after} cases.</div>}
      {refund && <div className="step">Judge account: refunded {refund.refund_id} ({refund.status}).</div>}
    </section>
  )
}
