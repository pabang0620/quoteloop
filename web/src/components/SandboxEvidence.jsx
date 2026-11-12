import { useEffect, useState } from 'react'
import { call } from '../api.js'

// Results of the PayPal sandbox checks (VERIFY.md), shipped with the app. Only PASS rows are claimed; the rest is listed as is.
export default function SandboxEvidence() {
  const [ev, setEv] = useState(undefined)
  useEffect(() => { call('', 'GET', '/api/sandbox-evidence').then(setEv).catch(() => setEv(null)) }, [])
  if (ev === undefined) return <p>Loading...</p>
  if (!ev) return <p>No sandbox results are bundled with this copy.</p>
  return (
    <div>
      <p>Checks run on the {ev.environment}, {ev.run_on}. Numbers are the check ids in {ev.source}. This page itself runs on the bundled mock unless sandbox keys are set.</p>
      <table><thead><tr><th>#</th><th>Passed on the PayPal sandbox</th><th>PayPal ids</th></tr></thead><tbody>
        {ev.passed.map((p) => <tr key={p.id}><td>{p.id}</td><td>{p.check}{p.note ? <><br /><small>{p.note}</small></> : null}</td><td>{p.evidence.map((e) => <div key={e}><code>{e}</code></div>)}</td></tr>)}
      </tbody></table>
      <h4>Not passed (no claim is made for these)</h4>
      <table><thead><tr><th>#</th><th>Status</th><th>Check</th><th>Why</th></tr></thead><tbody>
        {ev.not_passed.map((p) => <tr key={p.id}><td>{p.id}</td><td><span className="badge bad">{p.status}</span></td><td>{p.check}</td><td>{p.why}</td></tr>)}
      </tbody></table>
    </div>
  )
}
