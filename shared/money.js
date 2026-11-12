// All money is integer cents. Percentages are integer basis points (100 bps = 1%).
export const toCents = (value) => Math.round(Number(value) * 100)
export const fromCents = (cents) => (cents / 100).toFixed(2)
export const fmt = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const bpsOf = (cents, bps) => Math.round((cents * bps) / 10000)
export const discountBy = (cents, bps) => cents - bpsOf(cents, bps)
export const money = (cents, currency = 'USD') => ({ currency_code: currency, value: fromCents(cents) })
export const pctChange = (from, to) => (from === 0 ? 0 : Math.round(((to - from) / from) * 100))
