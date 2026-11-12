// Starts the three services in the exact state the video script (docs/VIDEO_SCRIPT.md) expects:
// bundled mock PayPal, no PayPal or API keys, a fresh database (yesterday's seeded deal and unsigned $19.99 charge),
// a 2 minute activity delay and a 2 minute judge refund.
//   npm run demo:video              rules mode; the Claude scene uses the recorded real run (Claude runs tab)
//   npm run demo:video -- --account both agents run live on your own Claude Code login (never an API key)
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const dir = join('data', `video-${stamp}`)
mkdirSync(dir, { recursive: true })
const account = process.argv.includes('--account')

Object.assign(process.env, {
  FORCE_MOCK: '1',
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  LLM_BACKEND: account ? 'account' : '',
  MOCK_TXN_LAG_MS: '120000',
  JUDGE_REFUND_DELAY_MS: '',
  BUYER_SEED_HISTORY: '1',
  BUYER_DB_FILE: join(dir, 'buyer.db'),
  BUYER_KEY_FILE: join(dir, 'buyer.key'),
  SUPPLIER_DB_FILE: join(dir, 'supplier.db'),
  SUPPLIER_KEY_FILE: join(dir, 'supplier.key'),
})
console.log(`Recording state: fresh data in ${dir}, bundled mock PayPal, ${account ? 'live Claude (local account)' : 'rules mode with the recorded Claude run'}. Open http://localhost:4101`)
await import('./run-all.js')
