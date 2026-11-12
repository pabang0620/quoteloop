import { call } from '../api.js'

export default function Cards({ deal, state, onDecide, onChanged }) {
  const approval = deal?.approval_id ? state?.approvals.find((a) => a.id === deal.approval_id) : null
  const paused = Boolean(state?.audit?.state?.paused)
  const alerts = paused ? state?.audit?.last?.alerts || [] : []
  return (
    <>
      {approval?.status === 'pending' && (
        <div className="card approve">
          <b>Approval needed: {approval.summary}</b>
          <ul>{approval.reasons.map((r) => <li key={r.code}>{r.text}</li>)}</ul>
          <p>Above this line Maya decides. If she approves, the agent still verifies the draft, co-signs and settles.</p>
          <button className="primary" onClick={() => onDecide(approval.id, 'approve')}>Approve</button>
          <button className="ghost" onClick={() => onDecide(approval.id, 'reject')}>Reject</button>
        </div>
      )}
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
