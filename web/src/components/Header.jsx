import { useState } from 'react'
import { call, usd } from '../api.js'

// What the rogue-charge button tells the visitor: what happens next and at what time.
function rogueDone(paypalMode, lagMs) {
  const at = new Date(Date.now() + (lagMs || 0)).toLocaleTimeString()
  const when = paypalMode === 'mock' ? `On the bundled mock it shows in PayPal activity after ${at} (${Math.round((lagMs || 0) / 60000)} min delay)` : `It shows in your PayPal activity within about 3 hours (PayPal's documented delay)`
  return `The supplier charged $19.99 without a co-signature (judge account, refunded automatically). ${when}; then press Check there. Yesterday's unsigned charge is already listed, so Check shows an alert right away.`
}

export default function Header({ mandates, mandateId, setMandateId, mode, setMode, llm, llmLabel, paypalMode, text, setText, presets = {}, onRun, running, onHuman, deal, onChanged, supplierBase, ck, lagMs }) {
  const mandate = mandates.find((m) => m.mandate_id === mandateId)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ cap: '130.00', ref: '127.00', over: '10', auto: '500.00', budget: '1840.00' })
  const [err, setErr] = useState(null)
  const [demoMsg, setDemoMsg] = useState(null)

  async function demo(path, body, done) {
    setDemoMsg(null)
    try {
      await call(supplierBase, 'POST', path, body)
      setDemoMsg(done)
    } catch (e) {
      setDemoMsg(e.message)
    }
    onChanged()
  }

  async function saveMandate(e) {
    e.preventDefault()
    setErr(null)
    try {
      const cents = (v) => Math.round(Number(v) * 100)
      await call('', 'POST', '/api/mandates/custom', { unit_cap_cents: cents(form.cap), reference_unit_cents: cents(form.ref), max_overorder_pct: Number(form.over), auto_approve_cents: cents(form.auto), budget_cents: cents(form.budget) })
      setMandateId('MND-CUSTOM')
      setEditing(false)
      onChanged()
    } catch (e2) {
      setErr(e2.message)
    }
  }
  const field = (key, label) => (
    <label key={key}>{label}<input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} inputMode="decimal" /></label>
  )

  return (
    <header className="head">
      <div className="top">
        <span className="logo"><img className="brand-logo brand-logo--chip" src="/logo-512.png" width="28" height="28" alt="QuoteLoop" />QuoteLoop <i>purchase desk</i></span>
        <span className="deal">{deal ? `Deal ${deal.quote_id || deal.deal_id}` : 'No deal yet'}</span>
        <span className="sp" />
        <div className="topbtns">
          <button className="ghost" onClick={onHuman} title="A buyer with no agent opens the supplier's quote link">Buyer with no agent</button>
          <button className="primary" onClick={onRun} disabled={running}>{running ? 'Running...' : 'Run deal'}</button>
        </div>
      </div>
      <div className="controls">
        <label>Mandate
          <select value={mandateId} onChange={(e) => setMandateId(e.target.value)}>
            {mandates.map((m) => <option key={m.mandate_id} value={m.mandate_id}>{m.label}</option>)}
          </select>
        </label>
        <button className="ghost" onClick={() => setEditing(!editing)}>Edit mandate</button>
        <label>Request
          <select value="" onChange={(e) => e.target.value && setText(presets[e.target.value])}>
            <option value="">Examples</option>
            <option value="hot">12oz hot cups, 2 cases</option>
            <option value="grinder">Grinder burr set ($1,180)</option>
          </select>
        </label>
        <label className="wide">{mode === 'claude' ? 'Your request (the model reads this sentence)' : 'Your request (rules read item and quantity)'}
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} />
        </label>
        <label>Agents
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="claude" disabled={!llm}>{llm ? (llmLabel || 'Claude') : 'Claude (not available here)'}</option>
            <option value="policy">Rules (fallback, same tools)</option>
          </select>
        </label>
      </div>
      {mandate && <p className="hint">{mandate.issuer.company} authorizes this buyer agent to purchase approved items up to {usd(mandate.negotiation.auto_approve_cents)} per order within the mandate. Larger orders need a person's approval.</p>}
      <p className="hint">{paypalMode === 'mock' ? 'Run deal = one deal on the bundled mock PayPal (same calls and response shapes). No PayPal login needed.' : 'Run deal = one deal on the sandbox PayPal account. No PayPal login needed.'}</p>
      <details className="demo">
        <summary>Demo controls: make the supplier misbehave (only for you)</summary>
        <div className="controls">
          <button className="ghost" onClick={() => demo('/api/demo/misbehave', { on: true, client_key: ck }, 'Armed: the next invoice draft gets an extra Rush handling $40.00 line. Run a deal to watch the buyer block it.')}>Add a Rush handling line to the next draft</button>
          <button className="ghost" onClick={() => demo('/api/demo/rogue-charge', { client_key: ck }, rogueDone(paypalMode, lagMs))}>Charge $19.99 with no co-signature</button>
          <button className="ghost" onClick={() => demo('/api/demo/low-stock', { on: true, client_key: ck }, 'Hot cups are low on stock for you only. Run a deal: the supplier has to offer a substitute.')}>12oz hot cups low on stock (this visitor only)</button>
        </div>
        {demoMsg && <p className="hint">{demoMsg}</p>}
      </details>
      {editing && (
        <form className="editor" onSubmit={saveMandate}>
          {field('cap', 'Cap per case ($)')}{field('ref', 'Reference per case ($)')}{field('over', 'Over-order limit (%)')}{field('auto', 'Auto-approve up to ($)')}{field('budget', 'Budget ($)')}
          <button className="primary" type="submit">Sign mandate</button>
          {err && <span className="bad">{err}</span>}
        </form>
      )}
    </header>
  )
}
