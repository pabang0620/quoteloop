import { HttpError, getJson, postJson } from '../shared/http.js'
import { MSG } from '../shared/protocol.js'

// The buyer's only channel to the supplier: signed messages over HTTP, plus the public Agent Card.
// It never reads the supplier's database, keys or PayPal credentials.
export function createSupplierClient({ db, config, gate, signer, supplierUrl }) {
  const base = supplierUrl.replace(/\/$/, '')

  async function discover(allowedMerchants) {
    const card = await getJson(`${base}/.well-known/agent-card.json`)
    if (!card.public_jwk || !card.supplier_id) throw new HttpError(502, 'Agent Card has no key', 'bad_card')
    if (allowedMerchants && !allowedMerchants.includes(card.supplier_id)) throw new HttpError(403, `${card.supplier_id} is not an allowed merchant in the mandate`, 'merchant_not_allowed')
    if (config.supplierKeyPin && card.kid !== config.supplierKeyPin) throw new HttpError(502, 'Supplier key does not match the pinned key', 'key_pin_mismatch')
    const pinned = db.get('peers', card.supplier_id)
    if (pinned && pinned.public_jwk.x !== card.public_jwk.x) throw new HttpError(502, 'Supplier key changed since it was first pinned', 'key_changed')
    if (!pinned) db.put('peers', card.supplier_id, { supplier_id: card.supplier_id, public_jwk: card.public_jwk, kid: card.kid, url: base, pinned_at: new Date().toISOString() })
    return card
  }

  async function send(type, taskId, body, supplierId) {
    const jws = gate.sign(type, supplierId, taskId, body)
    const data = await postJson(`${base}/a2a/messages`, { jws })
    return gate.open(data.jws)
  }

  async function register(card) {
    const jws = signRegistration()
    const data = await postJson(`${base}/a2a/messages`, { jws })
    return gate.open(data.jws, { expectType: [MSG.ACK] })

    function signRegistration() {
      return gate.sign(MSG.REGISTER, card.supplier_id, 'register', { public_jwk: signer.publicJwk, company: config.company, billing_email: config.billingEmail })
    }
  }

  return { discover, send, register, base }
}
