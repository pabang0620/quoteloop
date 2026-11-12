import dotenv from 'dotenv'
import { existsSync } from 'node:fs'

// One place that decides which settings file a service reads.
// ENV_FILE picks a file (for example a fresh copy of .env.example for a sandbox demo) without touching an older .env.
// Values already in the environment always win, so a shell or a host can override any line.
export const envFile = process.env.ENV_FILE || '.env'
export const envFileFound = existsSync(envFile)
if (envFileFound) dotenv.config({ path: envFile, quiet: true })

// Waits longer than this in mock mode usually come from an old .env, so the services say so at start.
const LONG_MOCK_WAIT_MS = 10 * 60 * 1000
export function envNotice() {
  const source = envFileFound ? envFile : `no ${envFile}, built-in defaults (same as .env.example)`
  const long = ['MOCK_TXN_LAG_MS', 'JUDGE_REFUND_DELAY_MS'].filter((k) => Number(process.env[k]) > LONG_MOCK_WAIT_MS)
  return long.length
    ? `settings: ${source}. ${long.join(', ')} above 10 minutes: the demo will wait that long. Start from .env.example (or set ENV_FILE) for the short demo waits.`
    : `settings: ${source}`
}
