import { invoiceBody } from '../shared/paypal.js'

// Draft the PayPal invoice for an accepted option. The draft is NOT sent: the buyer's code
// checks it line by line against the signed quote first.
export async function createDraft({ db, config, paypal, neg, buyer, tamper = false }) {
  const option = neg.accepted.option
  const invoiceNumber = await paypal.generateInvoiceNumber()
  const body = invoiceBody({
    invoiceNumber,
    po: `PO-${neg.quote_id}`,
    termType: option.terms,
    supplier: { name: config.name, email: config.email },
    buyer: { name: buyer.company, email: buyer.email },
    lines: [
      { name: option.name, qty: option.qty, unit_cents: option.unit_cents, discount_cents: option.pay_now_discount_cents },
      // Demo control only: a supplier that slips in a line that was never quoted.
      ...(tamper ? [{ name: 'Rush handling', qty: 1, unit_cents: 4000, discount_cents: 0 }] : []),
    ],
  })
  const link = await paypal.createInvoiceDraft(body)
  const invoiceId = String(link.href).split('/').pop()
  const invoice = await paypal.getInvoice(invoiceId)
  const draft = { invoice_id: invoiceId, invoice_number: invoiceNumber, invoice, sent: false, created_at: new Date().toISOString() }
  db.put('negotiations', neg.quote_id, { ...db.get('negotiations', neg.quote_id), invoice: draft })
  return draft
}

export async function discardDraft({ db, paypal, neg }) {
  if (neg.invoice?.invoice_id && !neg.invoice.sent) {
    try {
      await paypal.deleteInvoice(neg.invoice.invoice_id)
    } catch (err) {
      return { deleted: false, error: err.message }
    }
  }
  return { deleted: true }
}
