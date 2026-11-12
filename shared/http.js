import { z } from 'zod'

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function parse(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'invalid_input')
  return result.data
}

export const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })

// Central error handler: controllers only call next(err).
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message, code: err.code })
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, message: 'invalid input', code: 'invalid_input' })
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'invalid JSON', code: 'invalid_input' })
  console.error('[error]', err)
  return res.status(500).json({ success: false, message: 'Internal error', code: 'internal' })
}

export async function postJson(url, body, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : {}
  if (!res.ok) throw new HttpError(res.status, json.message || `HTTP ${res.status} from ${new URL(url).host}`, json.code)
  return json.data ?? json
}

export async function getJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  const json = text ? JSON.parse(text) : {}
  if (!res.ok) throw new HttpError(res.status, json.message || `HTTP ${res.status} from ${new URL(url).host}`, json.code)
  return json.data ?? json
}

// Server-sent events hub: each service streams its own timeline to the web page.
export function createEventBus(limit = 400) {
  const events = []
  const clients = new Set()
  return {
    emit(kind, data = {}) {
      const event = { seq: (events.at(-1)?.seq || 0) + 1, at: new Date().toISOString(), kind, ...data }
      events.push(event)
      if (events.length > limit) events.shift()
      for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`)
      return event
    },
    all: () => events.slice(),
    stream(req, res) {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
      res.flushHeaders()
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
    },
  }
}
