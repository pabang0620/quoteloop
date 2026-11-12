import { call, usd } from '../api.js'

// The rules the approval card did not flag, worded from the mandate the buyer signed. Only checks whose code is absent from the card are listed.
function passedChecks({ approval, opt, ev, mandate, supplier }) {
  const codes = new Set(approval.reasons.map((r) => r.code))
  const remaining = mandate.budget_state.remaining_cents
  return [
    !codes.has('over_charge_limit') && `Under the mandate's per-charge range, ${usd(opt.total_cents)} of ${usd(mandate.payment.amount_range.max_cents)}`,
    !codes.has('over_budget') && `Within budget, ${usd(remaining)} left, ${usd(remaining - opt.total_cents)} after`,
    !codes.has('sku_not_allowed') && !codes.has('above_cap') && ev?.cap_unit_cents != null && `Allowed item at or under the cap, ${opt.name}, ${usd(opt.unit_cents)} of ${usd(ev.cap_unit_cents)}`,
    supplier && mandate.payment.allowed_payees.includes(supplier.id) && `Allowed payee, ${supplier.name}`,
  ].filter(Boolean)
}

// Shown on top of the purchase order while a person has to decide.
export function ApprovalSlip({ deal, state, onDecide }) {
  const approval = deal?.approval_id ? state?.approvals.find((a) => a.id === deal.approval_id) : null
  if (approval?.status !== 'pending') return null
  const round = deal.rounds[deal.rounds.length - 1]
  const opt = round?.quote.options.find((o) => o.option_id === approval.option_id)
  const ev = round?.evaluation.options.find((o) => o.option_id === approval.option_id)
  const mandate = state.mandates.find((m) => m.mandate_id === deal.mandate_id)
  const supplier = state.supplier
  const supplierName = supplier?.name || 'the supplier'
  const signer = mandate?.issuer.signed_by || 'Maya'
  const first = signer.split(' ')[0]
  const netTerms = opt?.terms === 'NET_30'
  const remaining = mandate?.budget_state.remaining_cents
  const passed = opt && mandate ? passedChecks({ approval, opt, ev, mandate, supplier }) : []
  const total = opt ? usd(opt.total_cents) : ''
  return (
    <article className="slip">
      <div className="stamp pending">PENDING<small>APPROVAL</small></div>
      <div className="eyebrow">Approval needed, deal {deal.quote_id}</div>
      <h1>One purchase above the line</h1>
      <div className="sec"><span className="r">I</span>
        <div className="cols">
          <div><h3>Summary</h3>{opt ? <><div className="big">{total}</div><p>{opt.qty} x {opt.name}, from {supplierName}</p></> : <p>{approval.summary}</p>}</div>
          {opt && (
            <dl className="kv">
              <dt>Quote</dt><dd>{round.quote.quote_id} v{round.quote.version}</dd>
              <dt>Line</dt><dd>{opt.qty} x {usd(opt.unit_cents)} = {total}</dd>
              <dt>Terms</dt><dd>{netTerms ? 'NET_30 (invoice)' : `${opt.terms} (pay now)`}</dd>
              <dt>Invoice</dt><dd>drafted after approval</dd>
              {mandate && <><dt>Budget</dt><dd>{usd(remaining)} to {usd(remaining - opt.total_cents)}</dd></>}
            </dl>
          )}
        </div>
      </div>
      <div className="sec"><span className="r">II</span>
        <div><h3>Why this needs a signature</h3>
          <ol>
            {passed.map((t) => <li key={t}><span className="ok">Passed</span>: {t}</li>)}
            {approval.reasons.map((r) => <li key={r.code}><span className="need">Needs {first}</span>: {r.text}</li>)}
          </ol>
        </div>
      </div>
      <div className="sec"><span className="r">III</span>
        <div className="cols">
          <div><h3>After you sign, the agent still</h3>
            <ol>
              <li><b>Draft.</b> {supplierName} drafts a PayPal invoice and sends a signed copy of PayPal's JSON.</li>
              <li><b>Verify.</b> Buyer code checks every line, price, total, terms and recipient against signed quote v{round?.quote.version}.</li>
              {netTerms ? <li><b>Invoice.</b> Sent on NET_30 terms. Nothing is charged now.</li> : <>
                <li><b>Co-sign.</b> Your agent co-signs exactly {total} to {supplierName}: one-time nonce, expires in 10 min.</li>
                <li><b>Charge.</b> The supplier checks the co-signature, PayPal charges the saved PayPal, the invoice is marked PAID.</li>
                <li><b>Audit.</b> Your agent pairs the charge in your own PayPal activity with its co-signature (up to 3h).</li>
              </>}
            </ol>
          </div>
          <div><h3>What PayPal will do</h3>
            <ol>
              {netTerms ? <li>Sends the invoice to you with NET_30 terms</li> : <>
                <li>Checks the saved PayPal is valid and funds are available, at charge time</li>
                <li>Creates the order and capture, and lists it in your PayPal activity</li>
                {state.vault?.account_kind === 'judge' && <li>Judge account: refunds the charge automatically a few minutes later</li>}
              </>}
            </ol>
            <p className="hint">PayPal does not see the mandate or the co-signature. Supplier code checks it; your agent audits it.</p>
            <p className="states"><span className="st st-pending">Awaiting approval</span><span className="st st-held">Co-signed</span><span className="st st-captured">Captured</span><span className="st st-refunded">Refunded</span></p>
          </div>
        </div>
      </div>
      <div className="sig">
        <div><div className="line">sign here</div><small>Approver: {signer}, {mandate?.issuer.company || 'buyer'}</small></div>
        <div><div className="line">time recorded on approval</div><small>Saved with the approval; the agent then settles on its own</small></div>
        <div className="acts">
          <button className="ghost" onClick={() => onDecide(approval.id, 'reject')}>Reject</button>
          <button className="primary" onClick={() => onDecide(approval.id, 'approve')}>Sign and approve {total}</button>
        </div>
      </div>
    </article>
  )
}

export default function Cards({ deal, state, onChanged }) {
  const paused = Boolean(state?.audit?.state?.paused)
  const alerts = paused ? state?.audit?.last?.alerts || [] : []
  return (
    <>
      {deal?.status === 'blocked' && (
        <div className="card block">
          <b>Draft blocked</b>
          <ul>{(deal.draft?.mismatches || []).map((m) => <li key={m}>{m}</li>)}</ul>
          <p>Draft deleted, nothing sent, nothing charged.</p>
        </div>
      )}
      {alerts.length > 0 && (
        <div className="card block">
          <b>Audit alert: {alerts.length} charge(s) without your co-signature</b>
          <ol>
            <li>A charge reached your saved PayPal without asking your agent: {alerts.map((a) => `${a.transaction_id} ${a.amount} ${a.invoice_id || ''}`.trim()).join(', ')}.</li>
            <li>Your agent found it in your own PayPal records ({state?.audit?.last?.source || 'PayPal activity'}): no co-signature it issued carries this charge.</li>
            <li>Co-signing is paused, so the supplier gets no new co-signature until you press Resume.</li>
          </ol>
          <p>Review the PayPal activity, then revoke the saved PayPal in your PayPal account settings or open a dispute with PayPal.</p>
          <button className="ghost" onClick={async () => { await call('', 'POST', '/api/audit/resume'); onChanged?.() }}>Resume co-signing</button>
        </div>
      )}
    </>
  )
}
