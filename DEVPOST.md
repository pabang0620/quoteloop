# QuoteLoop (Devpost text)

Track: Best Use of Agentic Commerce. Sponsor tool: APIMatic Context Plugin (PayPal SDK).

## Elevator pitch

Maya buys supplies for 12 cafes (a demo persona), and her reorders still start with quotes that go back and forth by email. QuoteLoop gives her company and its supplier one AI agent each: the two agents negotiate the quote by signed messages and settle it on PayPal (saved PayPal account, invoice, capture) without a human click inside her limits. You can trust it because code, not the model, holds the money rules: an invoice that differs from the agreed quote is never sent, every charge carries her agent's co-signature for that exact amount, and her agent checks PayPal's own records for any charge without one.

## Inspiration

On 10/20/2026 Visa, BILL and Billtrust launched a live pilot "to enable trusted AI agents to initiate and complete approved buyer invoice payments end-to-end through supplier portals" ([Visa press release](https://corporate.visa.com/en/sites/visa-perspectives/press-releases/visa-bill-billtrust-launch-pilot.html)). That pilot starts at the invoice. The step before it, agreeing on the quote, is still email on both sides. The open commerce protocol work says the same: the UCP quote proposal is "a one-quotation-at-a-time loop, not a negotiation protocol" ([UCP issue 929](https://github.com/Universal-Commerce-Protocol/ucp/issues/929)), and the B2B procurement charter asks for flows where "approval authority remains with authorized humans" ([UCP issue 947](https://github.com/Universal-Commerce-Protocol/ucp/issues/947), both open proposals). We built the loop from request to settled PayPal payment, with two agents that each work for a different company.

## What it does

Maya buys supplies for 12 cafes (a demo persona). Her company signs one mandate (price caps, allowed items, over-order limit, auto-approve limit, budget, expiry) and saves its procurement PayPal with the supplier once, in a separate Vault "purchase later" flow. Then:

1. The buyer agent sends a request for quote. The supplier agent answers with priced options from the supplier's own price list, floor and concession schedule.
2. The buyer agent filters options by the mandate (an upsell to 3 cases is +50% quantity and +38% spend, above the 10% over-order limit), counters with pay-now, and accepts **$245.86** under mandate A Lean. Under **B Bulk** the same request buys 3 cases at **$339.98** and saves **$14.02** against accepting round 1.
3. The supplier creates a PayPal invoice draft. The buyer's code checks every line against the signed quote; a draft with an unquoted "Rush handling $40.00" line is deleted and nothing is charged.
4. The buyer agent co-signs that exact amount (Ed25519, 10 minute expiry, one-time nonce). The supplier checks the co-signature, charges the saved PayPal with Orders v2 (no payer present), and marks the invoice paid.
5. Above $500, a $1,180.00 grinder part waits for Maya's approval card; after she approves, the agent settles.
6. The buyer agent reads its own PayPal activity and pairs every charge with a co-signature. A charge with none raises an alert and pauses co-signing until Maya presses Resume.

## How we built it

- Three processes that share nothing but signed HTTP messages: the buyer service, the supplier service, and a PayPal stand-in for the no-key demo. Each company has its own key, database and PayPal credentials.
- Two Claude tool loops, one per company (`claude-sonnet-5-5`). The model picks moves; it never types an amount. Supplier tools price from the price list and take option ids; buyer tools re-check the mandate on accept and refuse to co-sign unless the draft check passed.
- PayPal: Vault v3 setup and payment tokens, Orders v2 capture with `vault_id`, `invoice_id` and `custom_id`, Invoicing (draft, send without email, delete, record payment and refund), refunds, Transaction Search, and the `INVOICING.INVOICE.PAID` webhook. Vault, Orders, refunds and Transaction Search go through the APIMatic-generated PayPal TypeScript SDK; Invoicing and Catalog through REST and the PayPal Agent Toolkit.
- Money is integer cents computed by code. Every PayPal write stores a claim row first and replays a lost answer with the same `PayPal-Request-Id`.
- React 19 and Vite for the page, Express and zod on the services, `node:test` tests with no network.

## Where AI is used, and what we actually ran

Real runs, 2026-11-12, both agents on Claude Sonnet through the developer's own Claude Code login (not an API key), PayPal on the bundled mock. They are saved in the repo and replayed on the page as "Recorded run: Claude Sonnet, 2026-11-12" when no model is connected:

- M1, free-form sentence "We are running low on hot cups, please get us two cases of the 12oz ones by Friday": `read_mandate`, `discover_supplier`, `send_rfq`, `evaluate_quote`, `counter` (pay-now), `evaluate_quote`, `accept_quote`, `verify_draft`, `cosign_charge`. Result: 2 cases, $245.86.
- M2, hot cups short: the supplier model read the catalog, found the requested item refused for stock, and quoted 12oz recycled cups as a same-category substitute; the buyer model bought 2 cases at $265.07.
- M3, mandate B Bulk: the buyer model followed the mandate to 3 cases at $339.98.

The hosted demo can also run the models live with an API key (capped per visitor and per day, off after 2026-12-22). That API-key path was not run by us; we say so in the README.

## Potential impact

**First user.** The purchasing lead of a multi-site food-service or retail business who reorders the same supplies every week from wholesale distributors (our demo persona, Maya, runs 12 cafes), and the sales desk of the distributor on the other side.

**The problem, with numbers.**
- 67% of B2B buyers favor a rep-free experience, and 45% used AI tools during a recent purchase (Gartner survey of 646 buyers, August to September 2025, reported by [Digital Commerce 360](https://www.digitalcommerce360.com/2026/03/17/gartner-b2b-buyers-rep-free-purchasing-ai-reshapes-sales/)).
- Suppliers already accept AI negotiation on routine contracts: Walmart reported that three out of four suppliers preferred negotiating with its AI over a human, saving "an average of three percent on contracts" ([Engadget, 2023](https://www.engadget.com/walmarts-suppliers-would-rather-negotiate-with-ai-than-a-human-162131831.html)). There, only the buyer side was automated.
- The payment end is moving: the Visa, BILL and Billtrust pilot is "live and processing end-to-end transactions" for approved invoices ([Visa](https://corporate.visa.com/en/sites/visa-perspectives/press-releases/visa-bill-billtrust-launch-pilot.html)).

We found no public figure for the cost of email quoting at a 12-site business, so we do not claim one.

**Why this is good for PayPal.** Every accepted quote becomes a PayPal invoice and an Orders capture on a saved PayPal account, so each agent-made B2B reorder settles on PayPal as merchant volume, on both sides' existing PayPal accounts. The risk of letting an agent charge a saved account is bounded by things PayPal already has: a per-charge co-signature carried in `custom_id`, the payer's own Transaction Search record, and refunds. A product PayPal could ship: verify an AP2-style payment mandate when a vaulted token is charged (PayPal is a named AP2 partner, [Google Cloud blog, 2025-09-16](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol/)), so the check our supplier code does today happens at the payment rail.

**What the demo proves today, and what needs PayPal or partners.**
- Proven in the app on the bundled mock, and with tests: the whole loop, the mandate rules, the draft check, co-signatures, the audit alert and pause, per-visitor demo state.
- Proven on the PayPal sandbox (VERIFY 2026-11-12, ids in the app's Sandbox evidence tab): Vault setup and payment tokens for a personal and a business payer, a vaulted Orders capture with no payer present, duplicate `invoice_id` refused, invoice send without email and draft delete, `PayPal-Request-Id` replay, SDK defaults, `Prefer: return=representation`, refunds COMPLETED.
- Needs PayPal: a buyer-owned REST app for the payer-side audit (the Transaction Search permission is now granted and a supplier-account Reporting recheck matched both visitors’ signed charges and paused only the visitor with the unsigned charge, VERIFY 7 partial, 10 and 12 PASS); recording an Orders capture as invoice method PAYPAL answered 404, so we record method OTHER with the capture id; verifying a payment mandate at charge time is the proposal above.
- Needs partners: a supplier that runs the supplier agent on its own price list, and a buyer company that signs a mandate.

## Challenges

- PayPal does not see the mandate, so we had to be precise about who checks what: the supplier's code verifies the co-signature before charging, and the buyer audits afterwards from its own PayPal records.
- Transaction Search lists a charge after "a maximum of three hours" ([PayPal docs](https://developer.paypal.com/docs/api/transaction-search/v1/search-get/)), so the audit has a pending state and the live deal is confirmed by reading the order back.
- Sandbox shape differences we fixed after running it: invoice item discounts come back negative, `send_invoice` without mail needs no invoicer email, and the capture call needs an empty JSON body.

## Accomplishments

- Two agents from two companies close and settle a deal with no human click, and the amount is never written by a model.
- A charge without the buyer's co-signature is visible to the buyer, and a draft that differs from the quote is never sent.
- The judge demo gives every visitor the same numbers ($245.86, $339.98, $14.02) with their own budget and alerts.

## What we learned

PayPal's saved-payment and invoicing APIs already carry everything an agent needs to prove what it agreed to (`invoice_id`, `custom_id`, request ids); the missing piece is a mandate check at charge time.

## What's next

PayPal verifying AP2-style payment mandates on vaulted charges; a REST app on the paying account so the audit reads the payer side on the sandbox; a price-list import for real suppliers.

## Built with

Claude (Sonnet), Claude Agent SDK, Anthropic SDK, PayPal Vault v3, Orders v2, Invoicing v2, Transaction Search, PayPal Agent Toolkit, APIMatic Context Plugin (PayPal TypeScript SDK), Node.js, Express, zod, React 19, Vite, node:sqlite.

## Testing instructions

**Try it:** https://quoteloop.35-216-2-121.sslip.io (hosted demo: bundled mock PayPal process, rules mode plus recorded Claude Sonnet runs; no login).

Same steps as the README. Every visitor gets their own budget, deals and alerts.

1. Open the demo (to run it yourself: `npm install`, `npm run build`, `npm start`, then http://localhost:4101). The first screen is ready: mandate **A Lean** is signed and the judge PayPal account is already saved with the supplier. No PayPal login is needed.
2. Press **Run deal**: option b is filtered by the over-order rule, the buyer counters with pay-now, accepts at **$245.86**, and the settlement list shows VERIFY MATCH, CO-SIGN, the charge and the invoice marked PAID, plus the time the charge shows in PayPal activity and the time of the automatic judge-account refund.
3. Switch the mandate to **B Bulk** and run again: 3 cases, **$339.98**, "Saved $14.02". Open the **Compare A vs B** tab.
4. Type `Grinder burr set, 1 unit` and run: an approval slip for **$1,180.00**. Press **Sign and approve**; the agent verifies, co-signs and settles.
5. Open **Demo controls**, press "Add a Rush handling line to the next draft", run a deal: the buyer blocks the draft, it is deleted, nothing is charged.
6. In **PayPal activity**, press Check: yesterday's deal is matched and refunded, and yesterday's $19.99 charge with no co-signature raises an alert that pauses co-signing until you press **Resume**.
7. Press **Buyer with no agent**: a person opens the supplier's quote link and pays.
8. If the daily live-run limit or the judge account minimum balance is reached, the same flow runs on simulated PayPal calls and the page says so.
9. Open the **Price list** tab (read-only without the owner token).
10. Open the **Claude runs** tab: three real runs recorded on 2026-11-12, replayed with their real tool order and timings. When a model is connected, pick it under Agents and type a free-form request instead.
11. Open the **Sandbox evidence** tab: the sandbox checks that passed, with PayPal ids, and the ones that did not.

## Sources

| Claim | Source |
|---|---|
| Visa, BILL and Billtrust live pilot, 10/20/2026 | https://corporate.visa.com/en/sites/visa-perspectives/press-releases/visa-bill-billtrust-launch-pilot.html |
| UCP quote proposal is "a one-quotation-at-a-time loop, not a negotiation protocol" (open, 2026-10-11) | https://github.com/Universal-Commerce-Protocol/ucp/issues/929 |
| UCP B2B procurement charter, "approval authority remains with authorized humans" (open, 2026-10-14) | https://github.com/Universal-Commerce-Protocol/ucp/issues/947 |
| 67% rep-free, 45% used AI, 646 buyers, Aug to Sep 2025 | https://www.digitalcommerce360.com/2026/03/17/gartner-b2b-buyers-rep-free-purchasing-ai-reshapes-sales/ |
| Walmart: three out of four suppliers prefer the AI, average three percent (2023) | https://www.engadget.com/walmarts-suppliers-would-rather-negotiate-with-ai-than-a-human-162131831.html |
| AP2 announcement, PayPal among partners, B2B procurement example (2025-09-16) | https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol/ |
| AP2 payment mandate verified by credential provider, network and merchant payment processor | https://ap2-protocol.org/ap2/payment_mandate/ |
| Transaction Search: "a maximum of three hours" | https://developer.paypal.com/docs/api/transaction-search/v1/search-get/ |
| Saved PayPal: "Payers don't need to be present when charged" | https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/ |
