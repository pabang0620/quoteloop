import { useEffect, useState } from 'react'
import { call, useEvents, usePolled } from './api.js'
import Header from './components/Header.jsx'
import BuyerPane from './components/BuyerPane.jsx'
import SupplierPane from './components/SupplierPane.jsx'
import Tabs from './components/Tabs.jsx'
import Notices from './components/Notices.jsx'

const PRESETS = { hot: '12oz hot cups, 2 cases, by Friday', grinder: 'Grinder burr set, 1 unit' }

export default function App() {
  const [tick, setTick] = useState(0)
  const [mandateId, setMandateId] = useState('MND-A-LEAN')
  const [mode, setMode] = useState('policy')
  const [text, setText] = useState(PRESETS.hot)
  const [activeDeal, setActiveDeal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const buyer = usePolled(() => call('', 'GET', '/api/state'), 1500, tick)
  // The supplier is asked only once the buyer has told the page where it is (no fixed address in the page).
  const supplierBase = buyer.data?.supplier_public_url || null
  const ck = buyer.data?.visitor || 'anonymous'
  const supplier = usePolled(() => (supplierBase ? call(supplierBase, 'GET', `/api/state?client=${ck}`) : Promise.resolve(null)), 2000, tick)
  const buyerEvents = useEvents('')
  const supplierEvents = useEvents(supplierBase)

  useEffect(() => { if (buyerEvents.length) setTick((t) => t + 1) }, [buyerEvents.length])
  useEffect(() => { if (supplierEvents.length) setTick((t) => t + 1) }, [supplierEvents.length])

  // The server only lists this visitor's own deals.
  // When a model is available, it is the default way to run a deal.
  const llmReady = Boolean(buyer.data?.llm_available)
  useEffect(() => { if (llmReady) setMode('claude') }, [llmReady])

  const deals = buyer.data?.deals || []
  const deal = deals.find((d) => d.deal_id === activeDeal) || deals[0] || null
  const reload = () => setTick((t) => t + 1)

  async function runDeal() {
    setBusy(true)
    setError(null)
    try {
      const created = await call('', 'POST', '/api/deals', { mandate_id: mandateId, text, mode })
      setActiveDeal(created.deal_id)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
      reload()
    }
  }

  async function humanBuyer() {
    try {
      const made = await call(supplierBase, 'POST', '/api/human-quote', { sku: 'CUP-12-HOT', qty: 2, client_key: ck })
      window.open(made.url, '_blank', 'noopener')
    } catch (err) {
      setError(err.message)
    }
  }

  const running = busy || ['negotiating', 'draft_received', 'settling'].includes(deal?.status)
  return (
    <div className="app">
      <Header
        mandates={buyer.data?.mandates || []} mandateId={mandateId} setMandateId={setMandateId}
        mode={mode} setMode={setMode} llm={buyer.data?.llm_available} llmLabel={buyer.data?.llm_label} paypalMode={buyer.data?.buyer?.paypal_mode}
        text={text} setText={setText} presets={PRESETS}
        onRun={runDeal} running={running} onHuman={humanBuyer} deal={deal} onChanged={reload} supplierBase={supplierBase} ck={ck} lagMs={buyer.data?.search_lag_ms}
      />
      <p className="lede">You are watching two companies' agents trade. Each runs as its own service with its own PayPal account.</p>
      <Notices buyer={buyer} supplier={supplier} deal={deal} error={error} />
      <div className="desk">
        <BuyerPane state={buyer.data} deal={deal} mandateId={mandateId} events={buyerEvents} onChanged={reload} supplierSlot={<SupplierPane state={supplier.data} deal={deal} events={supplierEvents} />} />
      </div>
      <Tabs buyer={buyer.data} supplier={supplier.data} buyerEvents={buyerEvents} supplierEvents={supplierEvents} supplierBase={supplierBase} onChanged={reload} />
    </div>
  )
}
