import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

// Files shipped with the app: recorded real model runs (replayed on the page when no model is connected) and the
// sandbox results from VERIFY.md. Read once at start; a broken file is skipped, never shown half-parsed.
export const BUILTIN_DIR = resolve(import.meta.dirname, '..', 'builtin')

const step = z.union([
  z.object({ t_ms: z.number().int().nonnegative(), type: z.literal('text'), text: z.string() }),
  z.object({ t_ms: z.number().int().nonnegative(), type: z.literal('tool'), name: z.string(), input: z.record(z.string(), z.unknown()), ok: z.boolean(), summary: z.string() }),
])

const agentRun = z.object({ steps: z.array(step), text: z.string(), duration_ms: z.number().int().nonnegative() })

export const recordedRunSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  label: z.string().startsWith('Recorded run: Claude Sonnet, '),
  recorded_at: z.string(),
  model: z.string(),
  backend: z.literal('account'),
  paypal: z.literal('bundled mock'),
  setup: z.array(z.string()),
  mandate_id: z.string(),
  request_text: z.string(),
  buyer: agentRun,
  supplier: z.array(agentRun.extend({ round: z.number().int(), kind: z.enum(['rfq', 'counter']) })),
  outcome: z.object({ status: z.string(), quote_id: z.string().nullable(), sku: z.string().nullable(), qty: z.number().int().nullable(), total_cents: z.number().int().nullable(), decided_by: z.string() }),
})

const evidenceSchema = z.object({
  run_on: z.string(),
  environment: z.string(),
  source: z.string(),
  passed: z.array(z.object({ id: z.string(), check: z.string(), evidence: z.array(z.string()), note: z.string().optional() })),
  not_passed: z.array(z.object({ id: z.string(), status: z.enum(['FAIL', 'BLOCKED', 'PARTIAL', 'NOT RUN']), check: z.string(), why: z.string() })),
})

function readJson(file, schema) {
  try {
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    console.error(`Skipping ${file}: ${err.message.slice(0, 200)}`)
    return null
  }
}

export function loadRecordedRuns(dir = join(BUILTIN_DIR, 'recorded-runs')) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(join(dir, f), recordedRunSchema)).filter(Boolean)
}

export function loadSandboxEvidence(file = join(BUILTIN_DIR, 'sandbox-evidence.json')) {
  return existsSync(file) ? readJson(file, evidenceSchema) : null
}
