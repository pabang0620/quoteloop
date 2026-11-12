import { useCallback, useEffect, useRef, useState } from 'react'

export const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export async function call(base, method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { credentials: base ? 'omit' : 'same-origin', method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.success === false) throw new Error(json.message || `Request failed (${res.status})`)
  return json.data
}

// Server-sent events from one service, kept as a growing list.
export function useEvents(base) {
  const [events, setEvents] = useState([])
  useEffect(() => {
    if (base === null) return undefined
    const es = new EventSource(`${base}/api/events`)
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data)
        setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev].slice(-300)))
      } catch { /* ignore a broken frame */ }
    }
    return () => es.close()
  }, [base])
  return events
}

// Poll a JSON endpoint; refresh now when `tick` changes.
export function usePolled(fetcher, ms, tick) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const ref = useRef(fetcher)
  ref.current = fetcher
  const load = useCallback(async () => {
    try {
      setData(await ref.current())
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, ms)
    return () => clearInterval(t)
  }, [load, ms, tick])
  return { data, error, reload: load }
}
