import { fmt, toCents } from '../shared/money.js'

// The sandbox returns an item discount as a negative amount (-5.02) for the 5.02 that was sent; the mock returns it positive.
const discountCents = (item) => (item.discount?.amount?.value ? Math.abs(toCents(item.discount.amount.value)) : 0)

// Line-by-line check of the supplier's PayPal invoice draft against the signed quote option.
// Anything that is not in the quote (extra line, other price, other total) makes the draft fail.
export function verifyDraft({ invoice, invoiceNumber, option, quote, supplierName, buyerEmail }) {
  const bad = []
  const items = invoice?.items || []
  if (invoice?.status !== 'DRAFT') bad.push(`Invoice status is ${invoice?.status}, expected DRAFT`)
  if (invoice?.detail?.currency_code !== 'USD') bad.push('Currency is not USD')
  if (invoice?.detail?.invoice_number !== invoiceNumber) bad.push(`Invoice number ${invoice?.detail?.invoice_number} differs from ${invoiceNumber}`)
  if (invoice?.detail?.reference !== `PO-${quote.quote_id}`) bad.push(`PO reference ${invoice?.detail?.reference} is not PO-${quote.quote_id}`)
  if (invoice?.detail?.payment_term?.term_type !== option.terms) bad.push(`Payment terms ${invoice?.detail?.payment_term?.term_type} differ from ${option.terms}`)
  // Sandbox answers keep only invoicer.email_address (no business_name), so the name is checked when PayPal returns one.
  const invoicerName = invoice?.invoicer?.name?.business_name
  if (supplierName && invoicerName && invoicerName !== supplierName) bad.push('Invoice is not from the quoting supplier')
  const recipient = invoice?.primary_recipients?.[0]?.billing_info?.email_address
  if (buyerEmail && recipient !== buyerEmail) bad.push(`Invoice is addressed to ${recipient || 'nobody'}, not ${buyerEmail}`)

  items.forEach((item, i) => {
    if (i >= 1) {
      bad.push(`Line ${i + 1} '${item.name} ${fmt(toCents(item.unit_amount?.value) * Number(item.quantity))}' not in signed quote v${quote.version}`)
      return
    }
    if (item.name !== option.name) bad.push(`Line 1 name '${item.name}' differs from '${option.name}'`)
    if (Number(item.quantity) !== option.qty) bad.push(`Line 1 quantity ${item.quantity} differs from ${option.qty}`)
    if (toCents(item.unit_amount?.value) !== option.unit_cents) bad.push(`Line 1 unit price ${item.unit_amount?.value} differs from ${fmt(option.unit_cents)}`)
    if (item.discount?.percent) bad.push('Line 1 has a percent discount that is not in the quote')
    const discount = discountCents(item)
    if (discount !== option.pay_now_discount_cents) bad.push(`Line 1 discount ${fmt(discount)} differs from ${fmt(option.pay_now_discount_cents)}`)
  })
  if (items.length === 0) bad.push('Invoice has no lines')

  const computed = items.reduce((s, it) => s + toCents(it.unit_amount?.value) * Number(it.quantity) - discountCents(it), 0)
  if (computed !== option.total_cents) bad.push(`Lines add up to ${fmt(computed)}, the quote total is ${fmt(option.total_cents)}`)
  if (toCents(invoice?.amount?.value) !== option.total_cents) bad.push(`Invoice total ${invoice?.amount?.value} differs from the quote total ${fmt(option.total_cents)}`)
  return { ok: bad.length === 0, mismatches: bad }
}
