import { Fragment, useEffect, useRef, useState } from 'react'
import { call, usd } from '../api.js'

// Saved transcripts of real Claude runs (account login, bundled mock PayPal), replayed with their real timings.
// The page never calls a model here and never presents scripted text as a model.
const SPEEDS = [1, 4]
const secs = (ms) => `+${(ms / 1000).toFixed(1)} s`

export function useRecordedRuns() {
  const [runs, setRuns] = useState([])
  useEffect(() => { call('', 'GET', '/api/recorded-runs').then((d) => setRuns(d?.runs || [])).catch(() => setRuns([])) }, [])
  return runs
}

const inputText = (input) => Object.entries(input || {}).filter(([k]) => k !== 'note').map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : v}`).join(', ')

function SupplierRound({ round }) {
  return (
    <li className="subround">
      <b>Supplier model, round {round.round} ({round.kind === 'rfq' ? 'quote' : 'counter'}), {(round.duration_ms / 1000).toFixed(1)} s</b>
      <ol>{round.steps.map((s, i) => <Step key={i} step={s} />)}</ol>
    </li>
  )
}

function Step({ step }) {
  if (step.type === 'text') return <li className="said"><small>{secs(step.t_ms)}</small> <i>{step.text.length > 320 ? `${step.text.slice(0, 320)}...` : step.text}</i></li>
  return <li className={step.ok ? '' : 'bad'}><small>{secs(step.t_ms)}</small> <code>{step.name}{inputText(step.input) ? `(${inputText(step.input)})` : ''}</code> {step.summary}</li>
}

// The buyer model's timeline; each supplier round sits under the buyer tool call that waited for it.
export function RecordedRunPlayer({ run }) {
  const [shown, setShown] = useState(Infinity)
  const [speed, setSpeed] = useState(4)
  const timer = useRef(null)
  useEffect(() => () => clearInterval(timer.current), [])
  useEffect(() => { clearInterval(timer.current); setShown(Infinity) }, [run?.id])
  if (!run) return null
  function replay() {
    clearInterval(timer.current)
    const start = Date.now()
    setShown(0)
    timer.current = setInterval(() => {
      const t = (Date.now() - start) * speed
      setShown(t)
      if (t > run.buyer.duration_ms) clearInterval(timer.current)
    }, 100)
  }
  const roundFor = (step) => {
    if (step.type !== 'tool' || !['send_rfq', 'counter'].includes(step.name)) return null
    const n = run.buyer.steps.filter((s) => s.type === 'tool' && ['send_rfq', 'counter'].includes(s.name) && s.t_ms <= step.t_ms).length
    return run.supplier.find((r) => r.round === n) || null
  }
  const steps = run.buyer.steps.filter((s) => s.t_ms <= shown)
  const playing = shown !== Infinity && shown <= run.buyer.duration_ms
  const o = run.outcome
  return (
    <div className="recorded">
      <p><span className="badge claude">{run.label}</span> {run.model}, both agents on the model, PayPal on the {run.paypal}. This is a saved transcript of a real run, replayed with its real timings. The page is not calling the model now.</p>
      <p className="legend">{run.setup.length ? `Set up: ${run.setup.join(', ')}. ` : ''}Mandate {run.mandate_id}. Sentence the model read: "{run.request_text}"</p>
      <div className="controls">
        <button className="ghost" onClick={replay} disabled={playing}>{playing ? 'Replaying...' : 'Replay this run'}</button>
        <label>Speed <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}</select></label>
        <small>Buyer model total {(run.buyer.duration_ms / 1000).toFixed(1)} s</small>
      </div>
      <ol className="trace">
        {steps.map((s, i) => {
          const round = roundFor(s)
          return (
            <Fragment key={i}>
              {round && <SupplierRound round={round} />}
              <Step step={s} />
            </Fragment>
          )
        })}
      </ol>
      {!playing && <p className="hint">Result: {o.status}{o.qty ? `, ${o.qty} x ${o.sku}` : ''}{o.total_cents !== null ? `, ${usd(o.total_cents)}` : ''}. The model never typed an amount: prices came from the supplier's pricing tools and every accept was re-checked by the mandate rules.</p>}
    </div>
  )
}

export default function RecordedRuns({ llmLabel }) {
  const runs = useRecordedRuns()
  const [id, setId] = useState(null)
  const run = runs.find((r) => r.id === id) || runs[0]
  if (!runs.length) return <p>No recorded model run is bundled with this copy.</p>
  return (
    <div>
      <p>{llmLabel ? `A model is connected here (${llmLabel}): pick Claude under Agents to run a new deal live. ` : 'No model is connected on this server, so Run deal uses the same tools by rules. '}Below are real Claude runs recorded with these tools.</p>
      <nav className="subnav">{runs.map((r) => <button key={r.id} className={r.id === run.id ? 'on' : ''} onClick={() => setId(r.id)}>{r.title}</button>)}</nav>
      <RecordedRunPlayer run={run} />
    </div>
  )
}
