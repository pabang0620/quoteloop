import { useEffect, useState } from 'react'
import { call, usd } from '../api.js'
import RecordedRuns from './RecordedRuns.jsx'
import SandboxEvidence from './SandboxEvidence.jsx'

const TABS = ['Audit trail', 'PayPal activity', 'Claude runs', 'Messages', 'Signatures', 'Compare A vs B', 'Price list', 'Sandbox evidence', 'Connect PayPal']
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

function Audit({ buyer }) {
  return (
    <table><thead><tr><th>Deal</th><th>Quote</th><th>Request</th><th>Mandate</th><th>Status</th><th>Total</th></tr></thead><tbody>
      {(buyer?.deals || []).map((d) => (
        <tr key={d.deal_id}><td>{d.deal_id}</td><td>{d.quote_id || '-'}</td><td>{d.request.qty} x {d.request.sku === 'CUP-12-HOT' ? '12oz hot cups' : d.request.sku === 'GRN-BURR-64' ? 'grinder burr set' : d.request.sku === 'CUP-12-RECYCLED' ? '12oz recycled cups' : d.request.sku}</td><td>{d.mandate_id}</td><td>{d.status}</td><td>{d.accepted ? usd(d.accepted.option.total_cents) : '-'}</td></tr>
      ))}
    </tbody></table>
  )
}

function Activity({ buyer, onChanged }) {
  const [busy, setBusy] = useState(false)
  const last = buyer?.audit?.last
  async function run() {
    setBusy(true)
    try { await call('', 'POST', '/api/audit/run') } finally { setBusy(false); onChanged() }
  }
  return (
    <div>
      <p>The buyer agent reads this company's own PayPal activity and pairs each charge with the co-signature it issued. {buyer?.buyer?.paypal_mode === 'mock' ? `On the bundled mock a charge shows up ${Math.round((buyer?.search_lag_ms || 120000) / 60000)} min after it happens (PayPal documents up to 3 hours).` : 'PayPal documents up to 3 hours before a charge shows up here.'}</p>
      <button className="primary" onClick={run} disabled={busy}>{busy ? 'Reading PayPal...' : 'Check PayPal activity'}</button>
      {last && <p className="hint">Source: {last.source === 'bundled mock' ? 'bundled mock PayPal' : last.source}.{last.side === 'payee' ? ' This sandbox demo has one REST app (the supplier\'s), so only charges that carry a QuoteLoop invoice, co-signature or demo tag are checked; a buyer-owned app checks every outgoing charge.' : ''}</p>}
      {last?.unavailable && <div className="card block"><b>Transaction Search is not enabled for this PayPal app</b><p>{last.unavailable.message}</p></div>}
      {last && (
        <table><thead><tr><th>When</th><th>Invoice</th><th>Amount</th><th>Status</th><th>Note</th></tr></thead><tbody>
          {last.rows.map((r, i) => (
            <tr key={`${r.transaction_id || r.quote_id}-${i}`} className={r.status === 'alert' ? 'rowbad' : ''}>
              <td>{new Date(r.at).toLocaleString()}</td><td>{r.invoice_id || '-'}</td><td>{money(r.amount)}</td>
              <td><span className={`badge ${r.status.startsWith('matched') ? 'good' : r.status === 'alert' ? 'bad' : ''}`}>{r.status === 'matched' || r.status === 'matched_weak' ? (r.refunded ? 'matched / refunded' : r.status.replace('_', ' ')) : r.status.replaceAll('_', ' ')}</span></td>
              <td>{r.note}{r.status === 'pending' && r.visible_by ? ` Press Check again after ${new Date(r.visible_by).toLocaleTimeString()}.` : ''}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      {last?.other_visitors > 0 && <p className="hint">Not listed: {last.other_visitors} judge-account {last.other_visitors === 1 ? 'charge' : 'charges'} by other visitors, each matched to that visitor's own co-signature.</p>}
    </div>
  )
}

function Messages({ events, label, deal }) {
  return (
    <div className="log">
      <h4>{label}</h4>
      {deal?.tool_calls?.length > 0 && <div className="trace"><b>{deal.model?.label} ({deal.model?.name}), tool calls of this deal:</b><ol>{deal.tool_calls.map((c, i) => <li key={i}><code>{c.name}</code> {c.summary}</li>)}</ol></div>}
      {events.slice(-60).reverse().map((e) => <div key={e.seq}><code>{e.at.slice(11, 19)}</code> {e.kind}{e.quote_id ? ` ${e.quote_id}` : ''}{e.status ? ` (${e.status})` : ''}</div>)}
    </div>
  )
}

function Signatures({ buyer, supplier }) {
  return (
    <div>
      <p>Buyer key <code>{buyer?.buyer.kid}</code>. Supplier key <code>{buyer?.supplier?.kid || supplier?.supplier.kid}</code> (pinned by the buyer on first contact). Every message is an Ed25519 JWS.</p>
      <table><thead><tr><th>Co-signature</th><th>Invoice</th><th>Amount</th><th>State</th><th>Expires</th></tr></thead><tbody>
        {(buyer?.cosigns || []).map((c) => <tr key={c.cosign_hash}><td><code>{c.cosign_hash.slice(0, 14)}...</code></td><td>{c.invoice_number}</td><td>${c.amount}</td><td>{c.state}</td><td>{new Date(c.exp * 1000).toLocaleTimeString()}</td></tr>)}
      </tbody></table>
    </div>
  )
}

function Compare({ tick }) {
  const [data, setData] = useState(null)
  useEffect(() => { call('', 'GET', '/api/compare').then(setData).catch(() => setData(null)) }, [tick])
  const row = (label, d) => (
    <tr><td>{label}</td>{d ? <><td>{d.qty} {d.qty === 1 ? 'case' : 'cases'}</td><td>{usd(d.total_cents)}</td><td>{usd(d.net_unit_cents)}</td><td>{d.saved_cents ? usd(d.saved_cents) : '-'}</td></> : <td colSpan="4">Run a deal under this mandate</td>}</tr>
  )
  return (
    <div>
      <p>The same request under two signed mandates gives two different deals.</p>
      <table><thead><tr><th>Mandate</th><th>Bought</th><th>Total</th><th>Net per case</th><th>Saved vs round 1</th></tr></thead><tbody>{row('A Lean', data?.a)}{row('B Bulk', data?.b)}</tbody></table>
    </div>
  )
}

function Connect({ buyer }) {
  const [err, setErr] = useState(null)
  const v = buyer?.vault
  async function connect() {
    try {
      const out = await call('', 'POST', '/api/vault/connect')
      window.location.href = out.approve_url
    } catch (e) { setErr(e.message) }
  }
  return (
    <div>
      <p>{v?.connected ? `Connected: ${v.account_kind} account${v.payer_email ? ` (${v.payer_email})` : ''}.` : 'Not connected.'} The default demo account is already connected.</p>
      <p>This is a separate step from any purchase: Maya approves once on PayPal's page that Northbeam Supply may charge this account, and the buyer agent's co-signature rule applies to every charge.</p>
      <button className="ghost" onClick={connect}>Connect another PayPal account</button>
      {err && <p className="bad">{err}</p>}
    </div>
  )
}

function PriceList({ supplier, supplierBase, onChanged }) {
  const [token, setToken] = useState('')
  const [edit, setEdit] = useState(null)
  const [msg, setMsg] = useState(null)
  const items = supplier?.catalog || []
  const pc = (bps) => `${bps / 100}%`
  const startEdit = (i) => setEdit({ sku: i.sku, floor: String(i.floor_cents / 100), stock: String(i.stock), prices: i.tiers.map((t) => String(t.price_cents / 100)) })
  async function save() {
    const item = items.find((i) => i.sku === edit.sku)
    try {
      const tiers = item.tiers.map((t, n) => ({ min: t.min, price_cents: Math.round(Number(edit.prices[n]) * 100) }))
      await call(supplierBase, 'POST', `/api/price-list/${edit.sku}`, { tiers, floor_cents: Math.round(Number(edit.floor) * 100), stock: Number(edit.stock) }, { 'X-Admin-Token': token })
      setMsg({ ok: true, text: 'Saved. The next quote uses these numbers.' })
      setEdit(null)
      onChanged()
    } catch (e) { setMsg({ ok: false, text: e.message }) }
  }
  return (
    <div>
      <p>The supplier owner's price list. Agents never set a price: they pick among options the pricing code builds from these numbers. The cost column is private and not shown.</p>
      <table><thead><tr><th>Item</th><th>Price per case by quantity</th><th>Floor (after every discount)</th><th>Stock / safety</th><th>Concessions R1 / R2 / R3</th><th>Pay-now</th><th /></tr></thead><tbody>
        {items.map((i) => (
          <tr key={i.sku}>
            <td>{i.name}</td>
            <td>{i.tiers.map((t) => `${t.min}+ cases: ${usd(t.price_cents)}`).join(', ')}</td>
            <td>{usd(i.floor_cents)}</td>
            <td>{i.stock} / {i.safety_stock}</td>
            <td>{i.concession_bps.map(pc).join(' / ')}</td>
            <td>{pc(i.pay_now_bps)}</td>
            <td><button className="ghost" onClick={() => startEdit(i)} disabled={!supplier?.price_edit_enabled}>Edit</button></td>
          </tr>
        ))}
      </tbody></table>
      {!supplier?.price_edit_enabled && <p className="hint">Editing is switched off here: no owner token is configured (SUPPLIER_ADMIN_TOKEN), so the public demo cannot change prices.</p>}
      {edit && (
        <div className="card">
          <b>{items.find((i) => i.sku === edit.sku)?.name}</b>
          <div className="chips">
            {edit.prices.map((p, n) => (
              <label key={n}>{items.find((i) => i.sku === edit.sku).tiers[n].min}+ cases $ <input value={p} inputMode="decimal" onChange={(e) => setEdit({ ...edit, prices: edit.prices.map((x, m) => (m === n ? e.target.value : x)) })} /></label>
            ))}
            <label>Floor $ <input value={edit.floor} inputMode="decimal" onChange={(e) => setEdit({ ...edit, floor: e.target.value })} /></label>
            <label>Stock <input value={edit.stock} inputMode="numeric" onChange={(e) => setEdit({ ...edit, stock: e.target.value })} /></label>
            <label>Owner token <input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
          </div>
          <button className="primary" onClick={save}>Save price list</button> <button className="ghost" onClick={() => setEdit(null)}>Cancel</button>
        </div>
      )}
      {msg && <p className={msg.ok ? 'hint' : 'bad'}>{msg.text}</p>}
    </div>
  )
}

export { Audit, Activity, Messages, Signatures, Compare, Connect }

export default function Tabs({ buyer, supplier, buyerEvents, supplierEvents, supplierBase, onChanged }) {
  const [tab, setTab] = useState(TABS[0])
  return (
    <section className="tabs">
      <nav>{TABS.map((t) => <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</nav>
      <div className="tabbody">
        {tab === 'Audit trail' && <Audit buyer={buyer} />}
        {tab === 'PayPal activity' && <Activity buyer={buyer} onChanged={onChanged} />}
        {tab === 'Messages' && <div className="two"><Messages events={buyerEvents} label="Buyer service" deal={buyer?.deals?.[0]} /><Messages events={supplierEvents} label="Supplier service" /></div>}
        {tab === 'Signatures' && <Signatures buyer={buyer} supplier={supplier} />}
        {tab === 'Compare A vs B' && <Compare tick={(buyer?.deals || []).map((d) => d.status).join()} />}
        {tab === 'Price list' && <PriceList supplier={supplier} supplierBase={supplierBase} onChanged={onChanged} />}
        {tab === 'Claude runs' && <RecordedRuns llmLabel={buyer?.llm_available ? buyer?.llm_label : null} />}
        {tab === 'Sandbox evidence' && <SandboxEvidence />}
        {tab === 'Connect PayPal' && <Connect buyer={buyer} />}
      </div>
    </section>
  )
}
