// Operator helper for sandbox runs: refund the given sandbox captures in full (restores the payer). Prints ids and status only.
// Usage: ENV_FILE=<sandbox env> node scripts/sandbox/refund-captures.js <captureId>:<cents>:<invoiceNumber> ...
import '../../shared/env.js'
import { createPaypal } from '../../shared/paypal.js'

const paypal = createPaypal({ label: 'supplier', clientId: process.env.SUPPLIER_PAYPAL_CLIENT_ID, clientSecret: process.env.SUPPLIER_PAYPAL_CLIENT_SECRET })
if (paypal.mode !== 'sandbox') throw new Error('sandbox credentials are not set')
for (const arg of process.argv.slice(2)) {
  const [captureId, cents, invoice] = arg.split(':')
  const refund = await paypal.refundCapture(captureId, Number(cents), invoice, { requestId: `ops-refund-${captureId}` })
  process.stdout.write(`${captureId} refund ${refund.id} ${refund.status}\n`)
}
