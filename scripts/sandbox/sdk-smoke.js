// VERIFY 12: the APIMatic SDK authenticates and reads Transaction Search with the sandbox credentials. Prints status only.
import '../../shared/env.js'
import { PaypalClient } from 'paypal'
const mk = (id, secret) => new PaypalClient({ serverOptions: { baseUrl: 'https://api-m.sandbox.paypal.com' }, oauth2: { clientId: id, clientSecret: secret }, logging: { level: 'off' } })
const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z')
const supplier = mk(process.env.SUPPLIER_PAYPAL_CLIENT_ID, process.env.SUPPLIER_PAYPAL_CLIENT_SECRET)
const buyer = mk(process.env.BUYER_PAYPAL_CLIENT_ID, process.env.BUYER_PAYPAL_CLIENT_SECRET)
const b = await supplier.transactionSearch.searchBalances({}).asApiResult()
process.stdout.write(`searchBalances (supplier keys): ${b.status} ${b.ok ? `ok, currencies ${b.value?.balances?.length}` : b.value?.kind}\n`)
const t = await buyer.transactionSearch.searchTransactions({ startDate: iso(Date.now() - 3 * 86400000), endDate: iso(Date.now()), fields: 'transaction_info', pageSize: 500 }).asApiResult()
process.stdout.write(`searchTransactions (buyer keys, 3 days): ${t.status} ${t.ok ? `ok, rows ${(t.value?.transactionDetails ?? t.value?.transaction_details)?.length}` : t.value?.kind}\n`)
