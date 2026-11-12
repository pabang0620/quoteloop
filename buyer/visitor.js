import { randomBytes } from 'node:crypto'

// The visitor key is issued by the server in a cookie and is the only thing the buyer service trusts for
// "whose deal is this". A client_key in a request body is ignored, so a visitor cannot pick another key to get a fresh
// budget, read someone else's deals or restart the daily live-charge count.
const COOKIE = 'ql_visitor'
const VALID = /^[A-Za-z0-9_-]{2,40}$/
const MAX_AGE_S = 30 * 24 * 3600

function readCookie(header) {
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) {
      const value = rest.join('=')
      if (VALID.test(value)) return value
    }
  }
  return null
}

export function visitorOf(req, res) {
  const existing = readCookie(req.get('cookie'))
  if (existing) return existing
  const key = `v${randomBytes(9).toString('base64url')}`
  res.append('Set-Cookie', `${COOKIE}=${key}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax`)
  return key
}
