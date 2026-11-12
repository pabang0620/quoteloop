# paypal-plan.md (QuoteLoop, APIMatic PayPal TypeScript SDK)

SDK: package `paypal` 2.29.0 (API spec 2.29), client `PaypalClient`, installed from `git+https://github.com/context-plugins/paypal-typescript-sdk#main` (not on npm, ships built `dist/`). Facts below come from `node_modules/paypal/sdk-map.md`, `map/operations/*.md` and the model files the map names. Nothing was written from memory.

Required reading loaded (binding): `typescript-integrate-paypal`, `typescript-getting-started`, `typescript-error-handling`, `typescript-client-initialization`, `typescript-configuration-resilience`, `typescript-testing`. `typescript-calling-endpoints`, `typescript-models` and `typescript-authentication` were applied through the map (flat request object, wire-shape stubs, OAuth client credentials) and only skimmed.

## 0. Repo survey

| Item | Finding |
| --- | --- |
| Module format | ESM (`"type": "module"`), plain JavaScript, no `tsconfig`, no type checker. Runtime Node >=22.13 (`engines`). Tests: `node --test test/*.test.js` (68 passing on the untouched tree) |
| PayPal layer | `shared/paypal.js` `createPaypal()` returns one adapter object per service. Live (keys set, not `FORCE_MOCK`): REST with its own OAuth, plus the PayPal Agent Toolkit. Mock (default): same REST paths against `mockpaypal/` |
| Adapter interface (kept as is) | `createSetupToken`, `createPaymentToken`, `chargeVault`, `createHumanOrder`, `captureOrder`, `getOrder`, `refundCapture`, `listTransactions`, `balance` plus Invoicing/Catalog methods and `rest`, `toolkit`, `mode`, `base` |
| Response shape | callers read the REST wire shape (`purchase_units`, `payment_source.paypal.email_address`, `transaction_details`). The SDK adapter converts every SDK model back to wire shape with the model's own `encode`, so no caller changes |
| Error type | `HttpError(status, message, code)` from `shared/http.js`, rendered by the central `errorHandler` |
| Store | `shared/docdb.js` (SQLite, `tx()` is synchronous `BEGIN IMMEDIATE`, PK `(col, id)`) |
| Exemplar to imitate | `shared/paypal.js` (adapter), `supplier/settle.js` (claim row `cosigns`), `test/settlement.test.js` (tests) |

## 1. Host and credential binding

| Item | Decision |
| --- | --- |
| Host | This SDK declares one environment (`https://api-m.sandbox.paypal.com`) and no `ServerEnvironment`. The app is sandbox-only (toolkit `context.sandbox: true`), so the adapter sets `serverOptions.baseUrl` to the exported constant `SANDBOX_BASE` explicitly and refuses to build the client when a different base URL is requested for a credentialed client |
| Credential | `SUPPLIER_PAYPAL_CLIENT_ID/SECRET` and `BUYER_PAYPAL_CLIENT_ID/SECRET`, passed to `oauth2: { clientId, clientSecret }`. Both must be non-empty or the SDK adapter is not built (an unset field would send no credential and answer 401) |
| Mock | no keys or `FORCE_MOCK=1`: the SDK is not used, the existing REST-to-mock adapter runs |
| Client lifetime | one `PaypalClient` per `createPaypal()` (per service and per account), held in the closure. Token cache lives on it |
| Logging | `logging: { level: "off" }` set explicitly (blocks `PAYPAL_CLIENT_LOG`). `logRequestBody` off, no per-call level. Provider debug id (`debug_id` / `PayPal-Debug-Id`) is logged by the app's own error path through the `HttpError` code, never the request body |
| Retry | SDK defaults kept for reads (GET retried on 408/429/5xx, 30 s per attempt). Writes are POST and are not in `httpMethodsToRetry`, so each write is sent once; the app re-sends only through its own claim (same `PayPal-Request-Id`) |
| Hooks / pagination / streaming | none exist in the SDK. Not needed except pagination: `listTransactions` reads one page (100 rows, SDK default), same as the toolkit call did |
| `Error` alias | the package exports a model type named `Error`; the code never imports it. The error family is imported as `PaypalError` |

## 2. Operation map (what moves to the SDK)

| App method | SDK operation | Request type | Returns | Wire |
| --- | --- | --- | --- | --- |
| `createSetupToken` | `client.vault.createSetupToken` | `Vault.CreateSetupTokenRequest` | `SetupTokenResponse` | `POST /v3/vault/setup-tokens` |
| `createPaymentToken` | `client.vault.createPaymentToken` | `Vault.CreatePaymentTokenRequest` | `PaymentTokenResponse` | `POST /v3/vault/payment-tokens` |
| `chargeVault` | `client.orders.createOrder` | `Orders.CreateOrderRequest` | `Order` | `POST /v2/checkout/orders` |
| `createHumanOrder` | `client.orders.createOrder` | `Orders.CreateOrderRequest` | `Order` | `POST /v2/checkout/orders` |
| `captureOrder` | `client.orders.captureOrder` | `Orders.CaptureOrderRequest` | `Order` | `POST /v2/checkout/orders/{id}/capture` |
| `getOrder` | `client.orders.getOrder` | `Orders.GetOrderRequest` | `Order` | `GET /v2/checkout/orders/{id}` |
| `refundCapture` | `client.payments.refundCapturedPayment` | `Payments.RefundCapturedPaymentRequest` | `Refund` | `POST /v2/payments/captures/{capture_id}/refund` (was toolkit `create_refund`) |
| `listTransactions` | `client.transactionSearch.searchTransactions` | `TransactionSearch.SearchTransactionsRequest` | `SearchResponse` | `GET /v1/reporting/transactions` (was toolkit `list_transactions`) |
| `balance` | `client.transactionSearch.searchBalances` | `TransactionSearch.SearchBalancesRequest` | `BalancesResponse` | `GET /v1/reporting/balances` |
| re-read of a capture | `client.orders.getOrder` | as above | `Order` | used by the unknown-outcome path |

All nine use `.asApiResult()` only where noted below; otherwise the throw-based form inside one `try/catch` that translates the PayPal error family once (`translate()` in `shared/paypalSdk.js`). No operation in scope resolves to `undefined`.

### Not in SDK, kept on REST or the Agent Toolkit

| Operation | Why |
| --- | --- |
| Invoicing (create draft, generate number, get, send, delete, record payment, record refund) | the SDK map has no Invoicing resource (resources are orders, payments, vault, transactionSearch, subscriptions) |
| Catalog Products (`create_product`) | no Catalog resource in the SDK |
| Webhook verification, Disputes | not used by this app, and not in the SDK |
| Subscriptions | in the SDK but this app has no subscriptions |
| Order `confirm`, `authorize`, `patch`, tracking, payments authorize/capture/void, vault get/list/delete | in the SDK, not used by this app, so not wired |

## 3. Contract sheet (fields, channels, defaults)

Request objects are flat and channel-blind. Wire names come from each model's `_keysMap`. `Req` = required.

### 3.1 `vault.createSetupToken`

| Field | Channel | Wire | Req | Notes |
| --- | --- | --- | --- | --- |
| `payPalRequestId` | header | `PayPal-Request-Id` | no | set from the claim row (section 4) |
| `body` | body | | yes | `SetupTokenRequest { customer?, paymentSource }` |
| `body.paymentSource.paypal` | | `payment_source.paypal` | | `VaultPayPalWalletRequest` |
| `.usageType` | | `usage_type` | no | `PayPalPaymentTokenUsageType.Merchant` |
| `.customerType` | | `customer_type` | no | from `PAYPAL_VAULT_CUSTOMER_TYPE`, default `CONSUMER` (enum member `Consumer`) |
| `.usagePattern` | | `usage_pattern` | no | from `PAYPAL_VAULT_USAGE_PATTERN`, default `UNSCHEDULED_POSTPAID` |
| `.experienceContext.returnUrl/cancelUrl` | | `return_url`, `cancel_url` | no | the app's own vault return and cancel pages |

`experienceContext` carries SDK-defaulted members that are sent even when omitted: `shipping_preference = GET_FROM_FILE`, `user_action = CONTINUE`. The old REST code did not send them. This is the SDK's behaviour, noted in VERIFY.

Error arms (map): `error` 400, `error2` 403, `error3` 422, `error4` 500, `undeclared`. Narrowed per operation, never across operations: the code reads only `err.status` and the `Error` model body (`message`, `name`, `debugId`, `details[].issue/description`) after confirming `payload.kind !== "undeclared"`.

### 3.2 `vault.createPaymentToken`

| Field | Channel | Wire | Req | Notes |
| --- | --- | --- | --- | --- |
| `payPalRequestId` | header | `PayPal-Request-Id` | no | from the claim row |
| `body.paymentSource.token` | body | `payment_source.token` | yes | `VaultTokenRequest { id: setupTokenId, type: VaultTokenRequestType.SetupToken }` |

Arms: 400, 403, 404, 422, 500, undeclared. Response guard: `id` must be present (optional in the model), else outcome unknown.

### 3.3 `orders.createOrder` (vault charge, merchant initiated)

| Field | Channel | Wire | Req | Notes |
| --- | --- | --- | --- | --- |
| `payPalRequestId` | header | `PayPal-Request-Id` | no | the co-signature nonce (claim row `cosigns`) |
| `prefer` | header | `Prefer` | no | default `return=minimal` is sent by the SDK; overridden to `return=representation` (see 4.3) |
| `body.intent` | body | `intent` | yes | `CheckoutPaymentIntent.Capture` |
| `body.purchaseUnits[0].amount` | body | `amount` | yes | `{ currencyCode: "USD", value }` from `money(cents)`, computed by `shared/money.js` |
| `.invoiceId`, `.customId` | body | `invoice_id`, `custom_id` | no | invoice number and co-signature hash: required by the audit (buyer matches the charge by `custom_id`) |
| `body.paymentSource.paypal.vaultId` | body | `vault_id` | no | the saved token; required for the charge |
| `.storedCredential` | body | `stored_credential` | no | only when `PAYPAL_STORED_CREDENTIAL=1`: `{ paymentInitiator: Merchant, usage: Subsequent }` |

Optional fields not set: `payer`, `processingInstruction`, `applicationContext`, `payee`, `items`, `shipping`, `description`, `softDescriptor`, `referenceId`, `payPalAuthAssertion`, `payPalClientMetadataId`, `payPalPartnerAttributionId`, `payPalMockResponse`. Arms: 400, 401, 422, default, undeclared (no 403 arm on this operation).

### 3.4 `orders.createOrder` (human order, payer approves on PayPal)

Same request type. `paymentSource.paypal.experienceContext = { returnUrl, cancelUrl, userAction: PayNow, shippingPreference: NoShipping }` (these four were in the old REST body). The SDK also fills `contact_preference`, `landing_page`, `payment_method_preference` defaults. `invoiceId` set (invoice number). `payPalRequestId` from the claim. `prefer` left at the SDK default (only `id` and `links` are read).

### 3.5 `orders.captureOrder`

| Field | Channel | Wire | Req | Notes |
| --- | --- | --- | --- | --- |
| `id` | path | | yes | the human order id stored on the negotiation |
| `payPalRequestId` | header | `PayPal-Request-Id` | no | from the claim row |
| `prefer` | header | `Prefer` | no | `return=representation`: the caller reads `purchase_units[0].payments.captures[0]`, which a minimal response omits |
| `body` | body | | no | omitted: no body, no content type |

Arms: 400, 401, 403, 404, 422, 500, default, undeclared.

### 3.6 `orders.getOrder`

`id` path (required). `fields`, `payPalMockResponse`, `payPalAuthAssertion` not set. Arms: 401, 404, default, undeclared. GET: SDK retry applies.

### 3.7 `payments.refundCapturedPayment`

| Field | Channel | Wire | Req | Notes |
| --- | --- | --- | --- | --- |
| `captureId` | path | `capture_id` | yes | capture from a charge this app recorded |
| `payPalRequestId` | header | `PayPal-Request-Id` | no | from the claim row |
| `body.amount` | body | `amount` | no | `{ currencyCode, value }` from `money(cents)`: partial or full refund is the app's decision, so it is sent |
| `body.invoiceId` | body | `invoice_id` | no | only when the caller passes one (judge refunds do) |
| `body.noteToPayer` | body | `note_to_payer` | no | `Judge sandbox balance restore` (existing text) |

Arms: 400, 401, 403, 404, 409, 422, `error500` (no body), default, undeclared. `prefer` left at the SDK default (only `id`, `status` are read).

### 3.8 `transactionSearch.searchTransactions` and `searchBalances`

`startDate`, `endDate` (required, query `start_date`, `end_date`). SDK defaults sent: `fields=transaction_info`, `balance_affecting_records_only=Y`, `page_size=100`, `page=1`. `searchBalances`: no field set (account default currency). Arms: transactions `searchError` default plus `undeclared`; balances 400, 403, 500, default, undeclared. Response is re-encoded to wire shape (`transaction_details[].transaction_info`).

## 4. Tables the skill requires

### 4.1 DURABLE WRITES: DUPLICATE CLAIMS

Claim = a row of its own in collection `paypal_claims` (key shown), written in `db.tx()` before the SDK call. A second claim on the same key is refused by the read-then-write inside `BEGIN IMMEDIATE` plus the `(col, id)` primary key. The row carries the `request_id` that is sent as `PayPal-Request-Id`, so a retried claim reuses the same key. Release (row deleted or marked) happens when the provider refuses the call.

| Write | Where the claim is stored | What rejects the second one | Where that rejection is caught | Where in the code |
| --- | --- | --- | --- | --- |
| createSetupToken | `paypal_claims` key `setup:{buyerId}` | state `CALLING` row refuses a second claim (409 `claim_in_flight`) | `claimWrite()` throws `HttpError`; the route's `next(err)` renders it | `supplier/vault.js` `startVaultSetup` via `runClaimed` |
| createPaymentToken | `paypal_claims` key `token:{setupId}` | state `CALLING` or `DONE` refuses (409) | same | `supplier/vault.js` `completeVaultSetup` via `runClaimed` |
| chargeVault (cosign) | `cosigns` key `{nonce}` (existing claim row, now with `in_flight`) plus the one-charge-per-quote check | `in_flight` row or any other non-failed co-signature on the quote refuses (409) | inside the `db.tx` block of `handleCosign` | `supplier/settle.js` `handleCosign` |
| chargeVault (rogue demo) | `paypal_claims` key `rogue:{invoiceId}` | `CALLING` or `DONE` | `claimWrite()` | `supplier/demo.js` |
| chargeVault + refund (health check) | `paypal_claims` key `health:{YYYY-MM-DD}` | `CALLING` or `DONE` for that day | `claimWrite()` | `supplier/refunds.js` `healthCheck` |
| createHumanOrder | `paypal_claims` key `order:{quoteId}` | `CALLING` or `DONE` | `claimWrite()` | `supplier/human.js` `startHumanPayment` |
| captureOrder | `paypal_claims` key `capture:{orderId}` | `CALLING` or `DONE` | `claimWrite()` | `supplier/human.js` `finishHumanPayment` |
| refundCapture | `refund_jobs` key `{captureId}` moved `scheduled` to `refunding` in one `db.tx` | only a `scheduled` job can be moved; a concurrent run sees `refunding` | `runDueRefunds` skips the job (no throw) | `supplier/refunds.js` `runDueRefunds` |

The key is always a value every caller of the same operation computes the same (buyer, setup token, quote, order, capture, day), never a per-attempt id. The rejection is by the store's own tx and primary key, not a read in another place or an in-process lock.

### 4.2 DURABLE WRITES: UNKNOWN OUTCOMES

Settled in the write's own `catch` inside `shared/paypalSdk.js`. Kinds: `connection`, `timeout` and a `decode` on a success status mean unknown. `auth` and `encode` mean the request never left, so no re-read and the claim is released. A 4xx other than 401/403/429 is a refusal (claim released). A 5xx answer is kept as unknown: the claim stays `UNKNOWN` and the next attempt reuses the same `PayPal-Request-Id`.

The SDK offers no search of orders, setup tokens or refunds by invoice id or custom id, and Transaction Search lags up to 3 hours. The re-read is therefore: `getOrder` where an order id is known (capture), otherwise a replay of the same write with the same `PayPal-Request-Id`, which PayPal answers with the original result. Replay support is a PayPal-documented behaviour of `PayPal-Request-Id` and is on the VERIFY list (item "Replay of a PayPal-Request-Id"); this is the one assumption in the sheet. If replay fails too, the answer stays unknown (HTTP 502, code `paypal_outcome_unknown`, never "failed").

| Write | The operation you re-read with | The reference you search by | Where in the code | The test that fails the connection |
| --- | --- | --- | --- | --- |
| createSetupToken | `vault.createSetupToken` replay | `PayPal-Request-Id` from the claim | `settleUnknown` in `shared/paypalSdk.js` | `test/paypalSdk.test.js` "setup token: lost answer is settled by replay, never-sent is not re-read" |
| createPaymentToken | `vault.createPaymentToken` replay | `PayPal-Request-Id` | same | "payment token: lost answer is settled by replay..." |
| chargeVault | `orders.createOrder` replay | `PayPal-Request-Id` = nonce | same | "vault charge: lost answer is settled by replay..." |
| createHumanOrder | `orders.createOrder` replay | `PayPal-Request-Id` | same | "human order: lost answer..." |
| captureOrder | `orders.getOrder` | order id (path) | same | "capture: lost answer is settled by getOrder..." |
| refundCapture | `payments.refundCapturedPayment` replay | `PayPal-Request-Id` | same | "refund: lost answer is settled by replay..." |

Each row has a second test where the credential is refused (`AuthError`) or the value will not encode and the assertion is that no re-read request was made.

### 4.3 OPTIONAL REQUEST FIELDS (summary of the per-operation tables above)

| Field | What requires it | Set it? |
| --- | --- | --- |
| `payPalRequestId` on every write | the DUPLICATE CLAIMS and UNKNOWN OUTCOMES rows | yes |
| `prefer` on `captureOrder` | caller reads the captures in the response | yes, `return=representation` |
| `prefer` on vault `createOrder` | `healthCheck` and the rogue demo read `payments.captures[0]` from the returned order | yes, `return=representation` |
| `prefer` on human `createOrder`, `refund` | nothing | no (SDK default stays) |
| `storedCredential` | env `PAYPAL_STORED_CREDENTIAL=1` | only then |
| `invoiceId`, `customId` on vault order | audit matching and duplicate-invoice protection | yes |
| `invoiceId`, `noteToPayer`, `amount` on refund | existing behaviour of the judge refund | yes |
| `customer`, `payer`, `applicationContext`, `shipping`, `items`, `description`, `payee`, auth-assertion and metadata headers | nothing | no |

The test "the request carries no key the code did not set" asserts headers (all but SDK-owned ones), query and body keys for each write.

### 4.4 CROSS-OPERATION INVARIANTS

| Invariant | Where the legal set comes from | Enforced where | The test that proves it |
| --- | --- | --- | --- |
| A vault id charged is a token this app saved for a buyer | `vaults` collection of the supplier db (every saved token, including the simulated ones) | `assertKnownVault()` in `supplier/vault.js`, called in `handleCosign`, `healthCheck`, rogue demo before the claim is written | "a vault id the supplier never saved is refused and the SDK is never called" |
| A capture refunded is a capture this app recorded | `charges` collection | `runDueRefunds` checks before moving the job to `refunding` | "a refund job for an unknown capture is refused and the SDK is never called" |
| An order captured is the order this app created for the quote | `negotiations[quoteId].human_order_id` (server-side record, never from the browser) | `finishHumanPayment` reads it from the db | existing human flow test plus "capture uses the stored order id" |

### 4.5 WHEN THE API SAYS NO

`translate()` in `shared/paypalSdk.js` is the one place the SDK error family becomes `HttpError`. The central `errorHandler` renders it.

| status | your app answers | the caller reads | test |
| --- | --- | --- | --- |
| a 4xx other than 401/403/429 | the same 4xx | the API's reason text (`details[0].description` or `message` from the typed arm; for `undeclared` the decoded raw body text, capped) | fake a 422 with a reason, assert the reason is in the `HttpError` message and the HTTP response |
| 401 / 403 | 502 | fixed: `PayPal refused our credentials` | fake a 401, assert 502 and the fixed text |
| 429 | 503 | fixed: `PayPal is rate limiting us` | fake a 429 |
| 5xx | 502 | fixed: `PayPal had an error` (write claim stays `UNKNOWN`) | fake a 500 |
| no response, on a write | 502 `paypal_outcome_unknown` after the re-read | `PayPal did not confirm the result yet. It is being checked, do not pay twice.` | the connection tests in 4.2 |
| no response, on a read | 502 | fixed: `PayPal could not be reached` | fake a connection error on `getOrder` |
| `decode` on a 2xx | 502 `paypal_outcome_unknown` (write) or `paypal_unreadable` (read) | fixed | fake a wrong-typed body |
| `decode` on an error status | the same status class as above | fixed | fake a 4xx with a body that does not fit |
| `auth` | 502 `paypal_auth` | fixed | fake a 401 on the token endpoint |
| `encode` | 500 `paypal_encode` (a bug, nothing sent) | fixed | fake a bad value |

The SDK `message` (method and URL) is logged in the server log line only and never returned.

## 5. Response guards (optional members that the code depends on)

| Call | Members asserted after the call | If missing |
| --- | --- | --- |
| createSetupToken | `id`, an `approve` or `payer-action` link | unknown outcome (write) |
| createPaymentToken | `id` | unknown outcome |
| createOrder | `id` | unknown outcome |
| captureOrder | `id`, `status` | unknown outcome |
| getOrder | `id`, `status` | `paypal_unreadable` |
| refund | `id`, `status` | unknown outcome |
| searchTransactions | none required (`transaction_details` may be absent when nothing matches) | empty list |
| searchBalances | `balances[0].available_balance.value` or `total_balance.value` | NaN guarded to 0 cents is not allowed: throws `paypal_unreadable` |

## 6. Test plan

- `test/paypalSdk.test.js`: fake `fetch` through `ClientOptions.fetch`, OAuth token answered on the token path, wire-shape bodies built with the models' own `encode`.
  - request shape per operation (verb, path, headers, body) and "no key the code did not set"
  - duplicate claim per durable write: the claim row is read from inside the fake `fetch`; a second concurrent call is refused before any request leaves
  - lost response per durable write (connection error) and the never-sent case (token endpoint 401, bad value)
  - error table 4.5
  - SDK adapter against the real `mockpaypal/` process (base URL override in the test only) proves the mock answers in the shape the SDK decodes
- Existing 68 tests stay green in the default mock run.

## 7. Assumptions and Blockers

| Kind | Item |
| --- | --- |
| Assumption (major, in VERIFY) | PayPal answers a replay of the same `PayPal-Request-Id` with the original result (orders, refunds, vault tokens). Used as the re-read for writes that have no id yet. Item "Replay of a PayPal-Request-Id" |
| Assumption (minor, in VERIFY) | the SDK-defaulted `shipping_preference`, `user_action`, `contact_preference`, `landing_page`, `payment_method_preference` members are accepted by the sandbox on setup tokens and human orders |
| Assumption (minor) | `searchTransactions` first page (100 rows) is enough for the 3-day audit window |
| Blocker | none. The one write that has no provider-side search (all of them) is covered by the replay above, which is why it is listed as an assumption with a VERIFY step and an explicit fallback (keep the claim `UNKNOWN`, show "being checked", never report failure) |

## REQUIRED READING

MUST load `typescript-error-handling` (error boundary, `translate()`), `typescript-client-initialization` (client built once), `typescript-configuration-resilience` (host override, retry gate, logging off), `typescript-testing` (fake fetch, token endpoint, lost-response cases).
