import { randomId, peekJws, signJws, verifyJws } from './jws.js'
import { HttpError } from './http.js'

const MAX_AGE_MS = 5 * 60 * 1000

// Signed message envelope shared by both services. Each side keeps its own gate,
// its own signing key and its own table of peer public keys.
export function createGate({ selfId, signer, peerKey }) {
  const seen = new Map()

  function sign(type, to, taskId, body) {
    return signJws({ v: 1, type, from: selfId, to, task_id: taskId, jti: randomId(8), iat: Date.now(), body }, signer)
  }

  function open(jws, { expectType } = {}) {
    let claimed
    try {
      claimed = peekJws(jws)
    } catch {
      throw new HttpError(400, 'Malformed message', 'bad_message')
    }
    const jwk = peerKey(claimed.from)
    if (!jwk) throw new HttpError(401, `Unknown sender ${claimed.from}`, 'unknown_sender')
    let msg
    try {
      msg = verifyJws(jws, jwk)
    } catch {
      throw new HttpError(401, 'Signature check failed', 'bad_signature')
    }
    if (msg.to !== selfId) throw new HttpError(400, 'Message is addressed to someone else', 'wrong_recipient')
    if (Math.abs(Date.now() - msg.iat) > MAX_AGE_MS) throw new HttpError(400, 'Message too old', 'stale_message')
    if (seen.has(msg.jti)) throw new HttpError(409, 'Message replay', 'replay')
    seen.set(msg.jti, msg.iat)
    for (const [jti, iat] of seen) if (Date.now() - iat > MAX_AGE_MS) seen.delete(jti)
    if (expectType && !expectType.includes(msg.type)) throw new HttpError(400, `Unexpected message ${msg.type}`, 'unexpected_type')
    return msg
  }

  return { sign, open, selfId }
}
