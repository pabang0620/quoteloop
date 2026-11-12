import { HttpError } from '../shared/http.js'
import { runClaimed } from '../shared/claims.js'

// Saving the buyer's procurement PayPal with the supplier ("purchase later"): its own flow,
// separate from any checkout. The buyer's admin approves once on PayPal's page.
export async function startVaultSetup({ db, config, paypal, buyerId }) {
  const setup = await runClaimed(db, `setup:${buyerId}`, (requestId) => paypal.createSetupToken({
    returnUrl: `${config.publicUrl}/vault/return`,
    cancelUrl: `${config.buyerUiUrl}/?vault=cancelled`,
    requestId,
  }))
  const approve = setup.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href
  if (!approve) throw new HttpError(502, 'PayPal gave no approval link', 'paypal_no_link')
  db.put('vault_setups', setup.id, { setup_id: setup.id, buyer_id: buyerId, created_at: new Date().toISOString() })
  return { setup_id: setup.id, approve_url: approve }
}

const kindFor = (config, email) => (config.judge.emails.includes(String(email || '').toLowerCase()) ? 'judge' : 'procurement')

export async function completeVaultSetup({ db, config, paypal, setupId }) {
  const pending = db.get('vault_setups', setupId)
  if (!pending) throw new HttpError(404, 'Unknown PayPal setup', 'unknown_setup')
  const token = await runClaimed(db, `token:${setupId}`, (requestId) => paypal.createPaymentToken(setupId, { requestId }), { keep: true })
  const email = token.payment_source?.paypal?.email_address
  const vault = {
    vault_id: token.id, buyer_id: pending.buyer_id, payer_email: email || null,
    account_kind: kindFor(config, email), rail: paypal.mode, active: true, created_at: new Date().toISOString(),
  }
  db.put('vaults', pending.buyer_id, vault)
  db.del('vault_setups', setupId)
  return vault
}

export function storePresetVault({ db, config, buyerId }) {
  const { presetVaultId, presetVaultPayerEmail } = config.paypal
  if (!presetVaultId || db.get('vaults', buyerId)) return null
  const vault = { vault_id: presetVaultId, buyer_id: buyerId, payer_email: presetVaultPayerEmail || null, account_kind: kindFor(config, presetVaultPayerEmail), rail: 'sandbox', active: true, created_at: new Date().toISOString(), preset: true }
  db.put('vaults', buyerId, vault)
  return vault
}

// Mock mode only: connect the demo buyer's judge account without a browser, so the first screen is ready.
export async function autoConnectMock({ db, config, paypal, buyerId }) {
  if (paypal.mode !== 'mock' || db.get('vaults', buyerId)) return null
  const { setup_id } = await startVaultSetup({ db, config, paypal, buyerId })
  const res = await fetch(`${paypal.base}/mock/auto-approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setup: setup_id, payer: 'judge' }) })
  if (!res.ok) throw new HttpError(502, 'Mock PayPal did not approve the demo account', 'mock_unreachable')
  return completeVaultSetup({ db, config, paypal, setupId: setup_id })
}

// The bundled mock PayPal keeps its vault in memory, so after a restart the saved mock-rail tokens in this
// supplier's database point at nothing and every charge fails with INVALID_RESOURCE_ID. At start-up, ask the mock
// about each one and forget the tokens it no longer knows; autoConnectMock and simulatedVault then save fresh ones.
// Only a clear 404 drops a record; an unreachable mock is retried, then left alone.
export async function dropLostMockVaults({ db, paypalFor, attempts = 10, waitMs = 500 }) {
  const dropped = []
  const rows = db.dump().filter((r) => r.col === 'vaults').map((r) => ({ id: r.id, v: JSON.parse(r.body) }))
  for (const { id, v } of rows) {
    if (v.rail !== 'mock') continue
    const paypal = paypalFor(id.startsWith('sim:') ? 'simulated' : 'mock')
    for (let i = 1; ; i += 1) {
      try {
        await paypal.getPaymentToken(v.vault_id)
        break
      } catch (err) {
        if (err.status === 404) {
          db.del('vaults', id)
          dropped.push(id)
          break
        }
        if (i >= attempts) throw err
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }
  }
  return dropped
}

// Cross-operation invariant: a vault id may be charged only if this supplier saved it (for any buyer, any rail).
export function assertKnownVault(db, vaultId) {
  if (!db.list('vaults', (v) => v.vault_id === vaultId).length) throw new HttpError(403, 'That saved PayPal is not one this supplier stored', 'unknown_vault')
}

export const vaultFor = (db, buyerId) => {
  const v = db.get('vaults', buyerId)
  return v?.active ? v : null
}
