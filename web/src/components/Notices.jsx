export default function Notices({ buyer, supplier, deal, error }) {
  const s = supplier?.data
  const simulated = deal?.draft?.rail === 'simulated' || deal?.charged?.rail === 'simulated'
  const lowBalance = s?.limits?.low_balance
  const vault = buyer.data?.vault
  return (
    <div className="notices">
      {error && <div className="note bad">{error}</div>}
      {buyer.error && !buyer.data && <div className="note bad">The buyer service is not answering ({buyer.error}).</div>}
      {vault && !vault.connected && <div className="note warn">No PayPal is saved with the supplier yet. Open the Connect PayPal tab first.</div>}
      {(lowBalance || simulated) && <div className="note warn">{lowBalance ? s?.notices?.low_balance : s?.notices?.simulation}</div>}
      {buyer.data?.audit?.state?.paused && <div className="note bad">Co-signing is paused after an audit alert. Check the PayPal activity tab.</div>}
      {vault?.paypal_mode === 'mock' && <div className="note info">PayPal runs in mock mode here (no sandbox keys): same flow, simulated PayPal responses.</div>}
      {deal?.fell_back && <div className="note warn">The model call failed for this deal, so the same tools ran by rules.</div>}
      {vault?.account_kind === 'judge' && <div className="note info">{vault?.paypal_mode === 'mock' ? 'Judge account on the bundled mock' : 'Judge sandbox account'} (balance auto-restored): each charge is refunded automatically{Number.isFinite(s?.judge_refund_delay_ms) ? ` about ${Math.round(s.judge_refund_delay_ms / 60000)} minutes later` : ''}.</div>}
    </div>
  )
}
