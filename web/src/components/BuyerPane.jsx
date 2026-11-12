import { call, usd } from '../api.js'
import Cards from './Cards.jsx'
import { RecordedRunPlayer, useRecordedRuns } from './RecordedRuns.jsx'

const DECIDER = { policy: 'rules', claude: 'Claude chose this' }
const NAMES = { 'CUP-12-HOT': '12oz hot cups', 'CUP-12-RECYCLED': '12oz recycled cups', 'GRN-BURR-64': 'grinder burr set' }
const itemName = (sku) => NAMES[sku] || sku

function MandateChips({ m }) {
  if (!m) return null
  const hot = m.checkout.line_items.find((l) => l.sku === 'CUP-12-HOT')
  return (
    <div className="chips">
      <span className="chip">Mandate {m.label}</span>
      <span className="chip">cap {usd(hot.unit_cap_cents)}</span>
      <span className="chip">ref {usd(hot.reference_unit_cents)}</span>
      <span className="chip">over-order {m.negotiation.max_overorder_pct}%</span>
      <span className="chip">auto up to {usd(m.negotiation.auto_approve_cents)}</span>
      <span className="chip">budget left {usd(m.budget_state.remaining_cents)}</span>
      <span className="chip" title="AP2-inspired: agent_recurrence ON_DEMAND">ON_DEMAND</span>
    </div>
  )
}

function Round({ round }) {
  const ev = round.evaluation
  const d = ev.decision
  return (
    <div className="round">
      <div className="rhead"><b>R{round.round}</b> quote <span className={`badge ${round.decided_by === 'claude' ? 'claude' : ''}`}>{DECIDER[round.decided_by] || 'policy'}</span></div>
      {ev.options.map((o) => (
        <div key={o.option_id} className={`opt ${o.eligible ? '' : 'out'}`}>
          <span>{o.label}: {o.qty} x {usd(o.unit_cents)} = {usd(o.total_cents)} <small>{o.terms === 'NET_30' ? 'NET_30' : 'pay now'}</small></span>
          {!o.eligible && <span className="why">filtered: {o.reasons.map((r) => r.text).join('; ')}</span>}
          {o.eligible && <span className="okk">net {usd(o.net_unit_cents)}/case</span>}
        </div>
      ))}
      <div className="decision">{d.action === 'counter' ? `Counter: ${d.reason}` : d.action === 'accept' ? `Accept automatically. ${d.reason}` : `Needs a human. ${d.reason}`}</div>
    </div>
  )
}

// The model's moves, in order. Tool inputs never carry an amount: prices come from the tools.
export function ModelTrace({ deal }) {
  if (deal?.fell_back) return <p className="trace fallback">The model call failed, so the same tools ran by rules (fallback).</p>
  if (!deal?.tool_calls?.length) return null
  return (
    <div className="trace">
      <b><span className="badge claude">{deal.model?.label || 'Claude'}</span> {deal.model?.name} chose these moves, in this order:</b>
      <ol>
        {deal.tool_calls.map((c, i) => (
          <li key={i} className={c.ok ? '' : 'bad'}><code>{c.name}{Object.keys(c.input || {}).length ? `(${Object.entries(c.input).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}</code> {c.summary}</li>
        ))}
      </ol>
      <small>No amount is ever typed by the model. Rules in the tools decide what is allowed.</small>
    </div>
  )
}

// When the charge shows in the buyer's own PayPal activity, and when the judge-account refund runs, as clock times.
function ActivityEta({ deal, lagMs, mock }) {
  const at = Date.parse(deal.charged.at || deal.started_at)
  const visible = new Date(at + (lagMs || 0)).toLocaleTimeString()
  const refund = deal.charged.refund_due_at ? new Date(deal.charged.refund_due_at).toLocaleTimeString() : null
  return (
    <>
      {mock ? `Shows in PayPal activity after ${visible} (bundled mock delay ${Math.round((lagMs || 0) / 60000)} min; PayPal documents up to 3 h).` : `Shows in your PayPal activity by ${visible} at the latest (PayPal documents up to 3 h).`}
      {refund && (deal.budget_restored ? ' Judge account refunded, budget restored.' : ` Judge account: refunded automatically shortly after ${refund} (the page restores your budget then).`)}
    </>
  )
}

function Settlement({ deal, lagMs, mock }) {
  if (!deal.accepted) return null
  const o = deal.accepted.option
  const blocked = deal.status === 'blocked'
  return (
    <details open className="settle">
      <summary>Settlement {usd(o.total_cents)} ({deal.draft?.invoice_number})</summary>
      <ol>
        <li>Accepted option {o.label} on quote v{deal.accepted.version}{deal.accepted.auto ? ' automatically' : ' after human approval'}{deal.saved_cents && deal.round1_acceptable ? `. Saved ${usd(deal.saved_cents)} vs accepting round 1.` : ''}</li>
        {deal.draft && <li>VERIFY draft {deal.draft.invoice_number} vs signed quote <span className={`badge ${blocked ? 'bad' : deal.draft.verified ? 'good' : ''}`}>{blocked ? 'BLOCKED' : deal.draft.verified ? 'MATCH' : 'checking'}</span></li>}
        {deal.cosign_hash && <li>CO-SIGN {usd(o.total_cents)}, expires in 10 min <code>{deal.cosign_hash.slice(0, 10)}...</code></li>}
        {deal.charged && <li>Charged with your co-signature (supplier-reported), order {deal.charged.order_id}, capture {deal.charged.capture_id}. {deal.charged.invoice_status === 'PAID' ? (deal.charged.invoice_method === 'OTHER' ? 'Invoice PAID (recorded as method OTHER with the capture id in the note; the sandbox does not accept an Orders capture as method PAYPAL).' : 'Invoice PAID.') : `Invoice ${deal.charged.invoice_status}.`} <ActivityEta deal={deal} lagMs={lagMs} mock={mock} /></li>}
        {deal.status === 'invoiced_net30' && <li>Invoiced on NET_30 terms. Nothing was charged.</li>}
      </ol>
      {deal.charged && deal.signed_messages > 0 && <p className="hint">Request to paid in {Math.max(1, Math.round((Date.parse(deal.charged.at) - Date.parse(deal.started_at)) / 1000))} s: {deal.signed_messages} signed messages between the two agents, {deal.accepted.auto ? 'no human click' : '1 human click (the approval)'}.</p>}
    </details>
  )
}

// No model on this server: offer the saved real run instead of pretending the rules are a model.
function RecordedInline() {
  const runs = useRecordedRuns()
  if (!runs.length) return null
  return (
    <details className="trace">
      <summary>No model is connected here, so Run deal uses rules. <span className="badge claude">{runs[0].label}</span> watch Claude run this kind of request (more in the Claude runs tab)</summary>
      <RecordedRunPlayer run={runs[0]} />
    </details>
  )
}

export default function BuyerPane({ state, deal, mandateId, onChanged }) {
  const m = state?.mandates.find((x) => x.mandate_id === (deal?.mandate_id || mandateId))
  const vault = state?.vault
  async function decide(id, decision) {
    try { await call('', 'POST', `/api/approvals/${id}/${decision}`) } finally { onChanged() }
  }
  return (
    <section className="pane">
      <h2>Brightcup Cafes <small>buyer service</small></h2>
      <MandateChips m={m} />
      <p className="legend">Cap = never above. Reference = accept without asking.</p>
      <p className="saved">{vault?.connected ? `PayPal saved with ${state?.supplier?.name || 'the supplier'} (${vault.account_kind} account): charges need your agent's co-signature, checked by the supplier and audited by your agent.` : 'No PayPal saved with the supplier yet.'}</p>
      {!deal && <p className="empty">Press Run deal. The buyer agent asks for 2 cases of 12oz cups and the supplier's agent answers.</p>}
      {deal && <p className="req">Request: {deal.request.qty} x {itemName(deal.request.sku)} <span className="badge">{deal.mode === 'claude' ? 'Claude' : 'rules'}</span> <span className={`badge st-${deal.status}`}>{deal.status.replaceAll('_', ' ')}</span></p>}
      {deal?.request_text && <p className="legend">Sentence the model read: "{deal.request_text}"</p>}
      {state && !state.llm_available && <RecordedInline />}
      <ModelTrace deal={deal} />
      {deal?.rounds.map((r) => <Round key={r.round} round={r} />)}
      {deal && <Settlement deal={deal} lagMs={state?.search_lag_ms} mock={state?.buyer?.paypal_mode === 'mock'} />}
      {deal?.error && <p className="bad">{deal.error}</p>}
      <Cards deal={deal} state={state} onDecide={decide} onChanged={onChanged} />
    </section>
  )
}
