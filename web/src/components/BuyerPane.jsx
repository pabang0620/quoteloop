import { Fragment } from 'react'
import { call, usd } from '../api.js'
import Cards, { ApprovalSlip } from './Cards.jsx'
import { RecordedRunPlayer, useRecordedRuns } from './RecordedRuns.jsx'

const DECIDER = { policy: 'rules', claude: 'Claude chose this' }
const NAMES = { 'CUP-12-HOT': '12oz hot cups', 'CUP-12-RECYCLED': '12oz recycled cups', 'GRN-BURR-64': 'grinder burr set' }
const itemName = (sku) => NAMES[sku] || sku
const money = (n) => `${n < 0 ? '-' : ''}${usd(Math.round(Math.abs(n) * 100))}`

// The stamp on the purchase order follows the deal status.
const STAMPS = {
  paid: ['PAID', '', (d) => d.draft?.invoice_number],
  blocked: ['BLOCKED', 'failed', () => 'NOTHING CHARGED'],
  rejected: ['REJECTED', 'failed', () => ''],
  failed: ['FAILED', 'failed', () => ''],
  awaiting_approval: ['PENDING', 'pending', () => 'APPROVAL'],
  invoiced_net30: ['NET 30', 'held', (d) => d.draft?.invoice_number],
}

function Stamp({ deal }) {
  const s = deal && STAMPS[deal.status]
  if (!s) return null
  const [word, cls, sub] = s
  return <div className={`stamp ${cls}`}>{word}{sub(deal) && <small>{sub(deal)}</small>}</div>
}

function MandateChips({ m }) {
  if (!m) return null
  const hot = m.checkout.line_items.find((l) => l.sku === 'CUP-12-HOT')
  return (
    <div className="chips">
      <span className="chip">cap {usd(hot.unit_cap_cents)}</span>
      <span className="chip">ref {usd(hot.reference_unit_cents)}</span>
      <span className="chip">over-order {m.negotiation.max_overorder_pct}%</span>
      <span className="chip">auto up to {usd(m.negotiation.auto_approve_cents)}</span>
      <span className="chip">budget left {usd(m.budget_state.remaining_cents)}</span>
      <span className="chip" title="AP2-inspired: agent_recurrence ON_DEMAND">ON_DEMAND</span>
    </div>
  )
}

const decisionText = (d) => (d.action === 'counter' ? `Counter: ${d.reason}` : d.action === 'accept' ? `Accept automatically. ${d.reason}` : `Needs a human. ${d.reason}`)

// Every option of every round as one ruled ledger: filtered options are struck out, the round's decision sits under its option.
function Ledger({ deal }) {
  const o = deal.accepted?.option
  return (
    <div className="ledger-wrap">
      <table>
        <thead><tr><th>Round</th><th>Item and reasoning</th><th className="n">Qty</th><th className="n">Unit</th><th>Terms</th><th className="n">Amount</th></tr></thead>
        <tbody>
          {deal.rounds.map((round) => {
            const ev = round.evaluation
            const d = ev.decision
            const placed = ev.options.some((x) => x.option_id === d.option_id)
            return (
              <Fragment key={round.round}>
                {ev.options.map((x, i) => {
                  const q = round.quote.options.find((y) => y.option_id === x.option_id)
                  return (
                    <tr key={x.option_id} className={x.eligible ? '' : 'out'}>
                      <td>R{round.round} {x.label}{i === 0 && <><br /><span className={`badge ${round.decided_by === 'claude' ? 'claude' : ''}`}>{DECIDER[round.decided_by] || 'policy'}</span></>}</td>
                      <td>{q?.name || itemName(x.sku)}
                        {!x.eligible && <span className="why">filtered: {x.reasons.map((r) => r.text).join('; ')}</span>}
                        {x.eligible && <span className="okk">net {usd(x.net_unit_cents)}/case</span>}
                        {x.option_id === d.option_id && <span className="rnote decision">{decisionText(d)}</span>}
                      </td>
                      <td className="n">{x.qty}</td><td className="n">{usd(x.unit_cents)}</td><td>{x.terms === 'NET_30' ? 'NET_30' : 'pay now'}</td><td className="n">{usd(x.total_cents)}</td>
                    </tr>
                  )
                })}
                {!placed && <tr><td>R{round.round}</td><td colSpan="5"><span className="rnote decision">{decisionText(d)}</span></td></tr>}
              </Fragment>
            )
          })}
          {o && (
            <tr className="total"><td /><td>Total payable{deal.draft?.invoice_number ? `, PayPal invoice ${deal.draft.invoice_number}` : ''}</td><td className="n">{o.qty}</td><td className="n">{usd(o.net_unit_cents)} net</td><td>{o.terms === 'NET_30' ? 'NET_30' : 'pay now'}</td><td className="n">{usd(o.total_cents)}</td></tr>
          )}
        </tbody>
      </table>
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
  if (!deal?.accepted) return <section><h2>Settlement record</h2><p className="empty">Fills in once the buyer accepts a quote: verify, co-sign, charge, invoice.</p></section>
  const o = deal.accepted.option
  const blocked = deal.status === 'blocked'
  return (
    <details open className="settle">
      <summary>Settlement record <span className="num">{usd(o.total_cents)}</span> ({deal.draft?.invoice_number})</summary>
      <ol>
        <li><span>Accepted option {o.label} on quote v{deal.accepted.version}{deal.accepted.auto ? ' automatically' : ' after human approval'}{deal.saved_cents && deal.round1_acceptable ? `. Saved ${usd(deal.saved_cents)} vs accepting round 1.` : ''}</span></li>
        {deal.draft && <li><span>VERIFY draft {deal.draft.invoice_number} vs signed quote <span className={`badge ${blocked ? 'bad' : deal.draft.verified ? 'good' : ''}`}>{blocked ? 'BLOCKED' : deal.draft.verified ? 'MATCH' : 'checking'}</span></span></li>}
        {deal.cosign_hash && <li><span>CO-SIGN {usd(o.total_cents)}, expires in 10 min <code>{deal.cosign_hash.slice(0, 10)}...</code></span></li>}
        {deal.charged && <li><span>Charged with your co-signature (supplier-reported), order {deal.charged.order_id}, capture {deal.charged.capture_id}. {deal.charged.invoice_status === 'PAID' ? (deal.charged.invoice_method === 'OTHER' ? 'Invoice PAID (recorded as method OTHER with the capture id in the note; the sandbox does not accept an Orders capture as method PAYPAL).' : 'Invoice PAID.') : `Invoice ${deal.charged.invoice_status}.`} <ActivityEta deal={deal} lagMs={lagMs} mock={mock} /></span></li>}
        {deal.status === 'invoiced_net30' && <li><span>Invoiced on NET_30 terms. Nothing was charged.</span></li>}
      </ol>
      {deal.charged && deal.signed_messages > 0 && <p className="hint">Request to paid in {Math.max(1, Math.round((Date.parse(deal.charged.at) - Date.parse(deal.started_at)) / 1000))} s: {deal.signed_messages} signed messages between the two agents, {deal.accepted.auto ? 'no human click' : '1 human click (the approval)'}.</p>}
    </details>
  )
}

// The last PayPal activity check, with the money-state colours. The full table is in the PayPal activity tab.
function ActivityBox({ last }) {
  if (!last?.rows?.length) return null
  const pill = (r) => {
    if (r.status === 'alert') return [['st-failed', 'alert']]
    if (r.status === 'pending') return [['st-pending', 'pending']]
    if (r.status === 'refund') return [['st-refunded', 'refund']]
    if (r.status.startsWith('matched')) return r.refunded ? [['st-captured', 'matched'], ['st-refunded', 'refunded']] : [['st-captured', 'matched / captured']]
    return [['', r.status.replaceAll('_', ' ')]]
  }
  return (
    <div className="box"><b>PayPal activity</b> (last check)
      {last.rows.slice(0, 5).map((r, i) => (
        <div className="act" key={`${r.transaction_id || r.quote_id}-${i}`}><span>{r.invoice_id || '-'} {money(r.amount)}</span><span>{pill(r).map(([c, t]) => <span key={t} className={`st ${c}`}>{t}</span>)}</span></div>
      ))}
    </div>
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

export default function BuyerPane({ state, deal, mandateId, onChanged, supplierSlot }) {
  const m = state?.mandates.find((x) => x.mandate_id === (deal?.mandate_id || mandateId))
  const vault = state?.vault
  const supplierName = state?.supplier?.name || 'Northbeam Supply'
  async function decide(id, decision) {
    try { await call('', 'POST', `/api/approvals/${id}/${decision}`) } finally { onChanged() }
  }
  return (
    <>
      <div className="po-col">
        <ApprovalSlip deal={deal} state={state} onDecide={decide} />
        <article className="paper">
          <Stamp deal={deal} />
          <div className="eyebrow">Purchase order, negotiated by two agents</div>
          <h1>{deal ? `Deal ${deal.quote_id || deal.deal_id}` : 'No deal yet'} <span className="sub">{deal ? deal.request_text || `${deal.request.qty} x ${itemName(deal.request.sku)}` : 'press Run deal'}</span></h1>
          <div className="parties">
            <div><span>Buyer</span><b>{m?.issuer.company || 'Brightcup Cafes'}</b><span>{m?.issuer.signed_by ? `${m.issuer.signed_by}, ` : ''}buyer service</span></div>
            <div><span>Supplier</span><b>{supplierName}</b><span>supplier service, its own PayPal account</span></div>
            <div><span>Signed mandate</span><b>{m ? `Mandate ${m.label}` : 'Mandate'}</b><MandateChips m={m} /></div>
          </div>
          <p className="legend">Cap = never above. Reference = accept without asking.</p>
          <p className="saved">{vault?.connected ? `PayPal saved with ${state?.supplier?.name || 'the supplier'} (${vault.account_kind} account): charges need your agent's co-signature, checked by the supplier and audited by your agent.` : 'No PayPal saved with the supplier yet.'}</p>
          {!deal && <p className="empty">Press Run deal. The buyer agent asks for 2 cases of 12oz cups and the supplier's agent answers.</p>}
          {deal && <p className="req">Request: {deal.request.qty} x {itemName(deal.request.sku)} <span className="badge">{deal.mode === 'claude' ? 'Claude' : 'rules'}</span> <span className={`badge st-${deal.status}`}>{deal.status.replaceAll('_', ' ')}</span></p>}
          {deal?.request_text && <p className="legend">Sentence the model read: "{deal.request_text}"</p>}
          {state && !state.llm_available && <RecordedInline />}
          <ModelTrace deal={deal} />
          {deal?.rounds.length > 0 && <Ledger deal={deal} />}
          {deal && m && <div className="foot"><span>Signed messages between the agents: {deal.signed_messages || 0} (Ed25519 JWS)</span><span>Budget left: {usd(m.budget_state.remaining_cents)} of mandate {m.label}</span></div>}
          {deal?.error && <p className="bad">{deal.error}</p>}
          <Cards deal={deal} state={state} onChanged={onChanged} />
        </article>
      </div>
      <aside className="margin">
        <Settlement deal={deal} lagMs={state?.search_lag_ms} mock={state?.buyer?.paypal_mode === 'mock'} />
        <ActivityBox last={state?.audit?.last} />
        {supplierSlot}
      </aside>
    </>
  )
}
