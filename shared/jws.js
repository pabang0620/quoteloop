import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => Buffer.from(s, 'base64url')

// Stable JSON: object keys sorted, so the same data always hashes the same.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const sha256hex = (data) => createHash('sha256').update(typeof data === 'string' ? data : canonical(data)).digest('hex')
export const sha256b64u = (data) => b64u(createHash('sha256').update(typeof data === 'string' ? data : canonical(data)).digest())
export const randomId = (bytes = 9) => randomBytes(bytes).toString('hex')

export function createKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicJwk: publicKey.export({ format: 'jwk' }) }
}

// A service keeps its own signing key: from an env PEM, else a file next to its own database.
export function loadSigningKey({ pem, file }) {
  let privatePem = pem ? pem.replace(/\\n/g, '\n') : null
  if (!privatePem && file && existsSync(file)) privatePem = readFileSync(file, 'utf8')
  if (!privatePem) {
    privatePem = createKeyPair().privatePem
    if (file) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, privatePem, { mode: 0o600 })
    }
  }
  const privateKey = createPrivateKey(privatePem)
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' })
  return { privateKey, publicJwk, kid: sha256hex(publicJwk).slice(0, 12) }
}

export function signJws(payload, { privateKey, kid }) {
  const head = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }))
  const body = b64u(JSON.stringify(payload))
  const sig = sign(null, Buffer.from(`${head}.${body}`), privateKey)
  return `${head}.${body}.${b64u(sig)}`
}

export function verifyJws(token, publicJwk) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('malformed signature')
  const [head, body, sig] = parts
  const key = createPublicKey({ key: publicJwk, format: 'jwk' })
  if (!verify(null, Buffer.from(`${head}.${body}`), key, fromB64u(sig))) throw new Error('bad signature')
  return JSON.parse(fromB64u(body).toString('utf8'))
}

export function peekJws(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('malformed signature')
  return JSON.parse(fromB64u(parts[1]).toString('utf8'))
}
