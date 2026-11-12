import { z } from 'zod'
import { ACCOUNT_LABEL, runAccountLoop } from './accountLlm.js'

// Minimal tool loop on the Claude Messages API. The client is injectable so tests can script the model.
export function toolSpecs(tools) {
  return tools.map((t) => {
    const { $schema, ...schema } = z.toJSONSchema(t.schema)
    return { name: t.name, description: t.description, input_schema: schema }
  })
}

export async function createAnthropicClient(apiKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  return new Anthropic({ apiKey })
}

export async function runToolLoop({ client, model, system, userText, tools, maxSteps = 8 }) {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const specs = toolSpecs(tools)
  const messages = [{ role: 'user', content: userText }]
  const calls = []
  // steps = what the model said and which tools it used, in order, with ms since the start (kept for recorded runs).
  const steps = []
  const started = Date.now()
  const since = () => Date.now() - started
  for (let step = 0; step < maxSteps; step += 1) {
    const response = await client.messages.create({ model, max_tokens: 4096, system, tools: specs, messages })
    messages.push({ role: 'assistant', content: response.content })
    for (const b of response.content) if (b.type === 'text' && b.text.trim()) steps.push({ t_ms: since(), type: 'text', text: b.text.trim() })
    const uses = response.content.filter((b) => b.type === 'tool_use')
    if (response.stop_reason !== 'tool_use' || uses.length === 0) {
      return { text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), calls, steps, duration_ms: since() }
    }
    const results = []
    for (const use of uses) {
      const tool = byName.get(use.name)
      let outcome
      try {
        if (!tool) throw new Error(`Unknown tool ${use.name}`)
        outcome = { ok: true, result: await tool.run(tool.schema.parse(use.input)) }
      } catch (err) {
        outcome = { ok: false, result: { error: err.message, code: err.code } }
      }
      calls.push({ name: use.name, input: use.input, ok: outcome.ok, result: outcome.result, t_ms: since() })
      steps.push({ t_ms: since(), type: 'tool', index: calls.length - 1 })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(outcome.result).slice(0, 12000), is_error: !outcome.ok })
    }
    messages.push({ role: 'user', content: results })
  }
  return { text: 'Stopped after the step limit.', calls, steps, duration_ms: since() }
}

// One entry point for both backends. llm = { model, client } (API) or { model, backend: 'account' } (local Claude Code login).
export function runModelLoop(llm, { system, userText, tools, maxSteps }) {
  if (llm.backend === 'account') return runAccountLoop({ model: llm.model, system, userText, tools, maxSteps, sdk: llm.sdk })
  return runToolLoop({ client: llm.client, model: llm.model, system, userText, tools, maxSteps })
}

// What the page and the deal record say about where the model answer came from.
export const llmLabel = (llm) => (!llm ? null : llm.backend === 'account' ? ACCOUNT_LABEL : `Claude (${llm.model}, API key)`)

// Config helper shared by both services: LLM_BACKEND=account wins and needs no key; otherwise a key enables the API backend.
export function llmFromConfig({ backend, anthropicKey, model }) {
  if (backend === 'account') return { model, backend: 'account', client: null, key: '' }
  return anthropicKey ? { model, client: null, key: anthropicKey } : null
}
