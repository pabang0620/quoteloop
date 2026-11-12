# QuoteLoop video script (2:49)

Start the app in the recording state with one command:

```bash
npm install
npm run demo:video      # builds the page, fresh database, bundled mock PayPal, no keys; open http://localhost:4101
```

Use a 1440 x 900 browser window. Record in one take in the order below; every scene is something the app shows in this state. Step numbers are the README / Devpost Testing instructions steps. Scenes that the app cannot show in this state are left out on purpose: the PayPal sandbox dashboard (the demo runs on the bundled mock), a live model call (no model is connected; the Claude scene replays the recorded real run and the label on screen says so), and the buyer audit on the sandbox (VERIFY 7 is blocked).

| Time | README step | On screen (what to do) | Narration / caption (English) | Criterion |
|---|---|---|---|---|
| 0:00-0:12 | 1 | First screen. Caption over it: "Visa, BILL and Billtrust: live pilot for agent invoice payments, 10/20/2026" | "Maya buys supplies for 12 cafes. Agents can now pay approved supplier invoices. Agreeing on the quote is still email." | Potential Impact, Presentation |
| 0:12-0:25 | 1 | Hover the mandate chips (cap, ref, over-order, auto-approve, budget, ON_DEMAND), the line "PayPal saved with Northbeam Supply", and the supplier pane (floor, stock, concessions) | "Maya signs one mandate. Her PayPal is saved with the supplier once. Prices and floors live in the supplier's code." | Design, Innovation/Idea |
| 0:25-0:48 | 2 | Press **Run deal**. Zoom on round 1: option b "filtered: +50% quantity, +38% spend vs request, limit 10%". Round 2: pay-now counter, accepted at **$245.86** | "The upsell breaks the over-order rule, so it never reaches Maya. The buyer agent counters with pay-now and accepts $245.86." | Technological Implementation, Innovation/Idea |
| 0:48-1:10 | 2 | Settlement list: VERIFY MATCH, CO-SIGN $245.86 (10 min), order and capture ids, Invoice PAID, the time it shows in PayPal activity and the refund time | "The buyer's code checks the PayPal invoice draft line by line, then co-signs this exact amount. The supplier checks that signature before it charges the saved PayPal." | Technological Implementation, Presentation |
| 1:10-1:24 | 3 | Mandate **B Bulk**, **Run deal**: 3 cases, **$339.98**, "Saved $14.02". Open **Compare A vs B** | "Same request, different mandate, different deal." | Innovation/Idea, Potential Impact |
| 1:24-1:38 | 4 | Type `Grinder burr set, 1 unit`, **Run deal**: approval slip **$1,180.00**. Press **Sign and approve**; the settlement list fills in | "Above the auto-approve line, Maya decides. The agent still settles." | Design |
| 1:38-1:50 | 5 | **Demo controls**, "Add a Rush handling line to the next draft", **Run deal**: the "Draft blocked" card: "Line 2 'Rush handling $40.00' not in signed quote v2", "Draft deleted, nothing sent, nothing charged." | "A draft that does not match the signed quote is never sent and never charged." | Innovation/Idea, Design |
| 1:50-2:06 | 6 | **PayPal activity**, Check: yesterday's deal matched / refunded, yesterday's $19.99 charge with no co-signature as an alert, co-signing paused; press **Resume** | "Any charge without the agent's co-signature shows up in the buyer's own PayPal records, and co-signing stops until Maya looks." Caption: "Shown on the bundled mock. On the sandbox, charges carry the co-signature hash in PayPal's records." | Technological Implementation, Innovation/Idea |
| 2:06-2:16 | 7 | Press **Buyer with no agent**: the quote link page, the mock approval page, "Paid" | "No agent on the buyer side? The supplier's agent quotes by link." | Potential Impact |
| 2:16-2:31 | 10 | **Claude runs** tab, "Hot cups short, the supplier model offers a substitute", speed 4x, Replay. The badge "Recorded run: Claude Sonnet, 2026-11-12" stays in view | "This is a recorded real run of Claude Sonnet. The supplier model finds the cups short and offers recycled cups; the buyer model checks the mandate and buys. Neither model ever types a price." | Technological Implementation |
| 2:31-2:40 | 11 | **Sandbox evidence** tab: rows 4 (vaulted capture ids), 6, 9, 13 | "On the PayPal sandbox, the saved-PayPal charge with no payer present, invoice handling and request-id replay passed." | Technological Implementation |
| 2:40-2:49 | - | Caption card: "Suppliers: quotes paid into PayPal at acceptance. Buyers: mandate-bound purchases. PayPal: the rail for agent B2B." Then "Next: PayPal verifying AP2-style payment mandates on vaulted charges. Built with the APIMatic Context Plugin (PayPal SDK)." | Read the last caption line only. | Potential Impact, Presentation |

Total 2:49. If a scene runs long, trim scene 2:31-2:40 first.

## Before recording

- The settlement list shows the time the charge appears in PayPal activity (2 minutes on the bundled mock). Scene 1:50-2:06 does not need to wait: yesterday's deal and yesterday's unsigned $19.99 charge are seeded.
- Do not press "Charge $19.99 with no co-signature" during the take; it adds a second alert two minutes later.
- To film a live model instead of the recording, start with `npm run demo:video -- --account` (your own Claude Code login, never an API key), pick Claude under Agents and change the caption to "Live run, Claude Sonnet (local account)".
