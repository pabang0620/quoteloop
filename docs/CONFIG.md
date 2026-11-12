# Configuration

## Environment variables

Nothing is required. The defaults run everything on the bundled mock. Full list with comments: `.env.example`.

| Variable | Purpose |
|---|---|
| `FORCE_MOCK` | `1` = never use real PayPal or Claude credentials, even if set |
| `LLM_BACKEND` | `account` = run both agents through your own Claude Code login (local use, no API key is read or sent) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | optional API-key backend for the hosted demo, model defaults to `claude-sonnet-5-5` |
| `SUPPLIER_PAYPAL_CLIENT_ID`, `SUPPLIER_PAYPAL_CLIENT_SECRET`, `SUPPLIER_PRESET_VAULT_ID` | supplier sandbox app and the judge account's saved PayPal |
| `BUYER_PAYPAL_CLIENT_ID`, `BUYER_PAYPAL_CLIENT_SECRET` | buyer sandbox app (needs Transaction Search for the audit) |
| `BUYER_ACTIVITY_SIDE` | `payer` (default, the buyer app belongs to the paying account) or `payee` (sandbox demo with one shared REST app) |
| `ENV_FILE` | settings file to read instead of `.env` |
| `SUPPLIER_PAYPAL_WEBHOOK_ID` | id of the webhook registered in the PayPal dashboard for `INVOICING.INVOICE.PAID` (the mock needs none) |
| `SUPPLIER_ADMIN_TOKEN`, `BUYER_ADMIN_TOKEN` | enable the owner price-list edit and `/admin/*` (balance, refunds, `POST /admin/daily-check`, `POST /admin/reset-demo`) |
| `CLAUDE_RUNS_PER_CLIENT_PER_DAY`, `CLAUDE_RUNS_PER_DAY`, `LLM_LIVE_UNTIL` | model run caps and end date |
| `MOCK_TXN_LAG_MS` | delay before a charge shows in the bundled mock's activity (default 2 minutes; PayPal documents up to 3 hours) |
| `JUDGE_REFUND_DELAY_MS` | judge-account refund delay (empty = 2 minutes on the bundled mock, 10 minutes on the sandbox) |
