// Turn a short purchase request into structured fields with fixed word rules. Policy mode uses this. In Claude mode the model
// reads the sentence itself and passes the item and the number of cases to send_rfq; code then checks them (buyer/deals.js adoptRequest).
const SKUS = [
  { sku: 'CUP-12-RECYCLED', words: ['recycled'] },
  { sku: 'GRN-BURR-64', words: ['grinder', 'burr'] },
  { sku: 'CUP-12-HOT', words: ['cup', 'hot'] },
]

export function parseRequestText(text) {
  const t = String(text || '').toLowerCase()
  const hit = SKUS.find((s) => s.words.some((w) => t.includes(w)))
  const qtyMatch = t.match(/(\d{1,3})\s*(?:cases?|units?|sets?|pcs|x)\b/) || t.match(/\b(\d{1,3})\b(?!\s*oz)/)
  const needBy = t.match(/by\s+([a-z]+day|\d{4}-\d{2}-\d{2})/)
  return { sku: hit?.sku || 'CUP-12-HOT', qty: qtyMatch ? Math.max(1, Number(qtyMatch[1])) : 1, need_by: needBy ? needBy[1] : undefined }
}
