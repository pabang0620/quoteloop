// Local development only: runs the same tools and system prompt through the Claude Agent SDK, which uses the
// developer's Claude Code login instead of an API key. Enabled with LLM_BACKEND=account. The result has the same
// shape as runToolLoop in llm.js ({ text, calls }), so the rest of the app cannot tell the difference.
const SERVER_NAME = 'quoteloop'
const MAX_TURNS = 14

export const ACCOUNT_LABEL = 'Claude Sonnet (local account)'

// The Claude Code process must not see an API key: with one present it would bill the API instead of the login.
export function withoutApiKey(env = process.env) {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = env
  return rest
}

const loadSdk = () => import('@anthropic-ai/claude-agent-sdk')

const clip = (value) => JSON.stringify(value ?? null).slice(0, 12000)

export async function runAccountLoop({ model, system, userText, tools, maxSteps = MAX_TURNS, sdk, env = process.env }) {
  const agentSdk = sdk || (await loadSdk())
  const calls = []
  const steps = []
  const started = Date.now()
  const since = () => Date.now() - started
  const mcpTools = tools.map((def) => agentSdk.tool(def.name, def.description, def.schema.shape, async (input) => {
    let outcome
    try {
      outcome = { ok: true, result: await def.run(def.schema.parse(input)) }
    } catch (err) {
      outcome = { ok: false, result: { error: err.message, code: err.code } }
    }
    calls.push({ name: def.name, input, ok: outcome.ok, result: outcome.result, t_ms: since() })
    steps.push({ t_ms: since(), type: 'tool', index: calls.length - 1 })
    return { content: [{ type: 'text', text: clip(outcome.result) }], isError: !outcome.ok }
  }))
  const server = agentSdk.createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools: mcpTools })
  const stream = agentSdk.query({
    prompt: userText,
    options: {
      model,
      systemPrompt: system,
      tools: [],
      allowedTools: [`mcp__${SERVER_NAME}__*`],
      mcpServers: { [SERVER_NAME]: server },
      maxTurns: maxSteps,
      effort: 'medium',
      settingSources: [],
      env: withoutApiKey(env),
    },
  })
  let text = ''
  for await (const message of stream) {
    if (message.type === 'assistant') {
      for (const b of message.message?.content || []) if (b.type === 'text' && b.text.trim()) steps.push({ t_ms: since(), type: 'text', text: b.text.trim() })
      continue
    }
    if (message.type !== 'result') continue
    if (message.subtype === 'success') text = String(message.result || '')
    else if (message.subtype === 'error_max_turns') text = 'Stopped after the step limit.'
    else throw new Error(`Account agent failed: ${message.subtype}`)
  }
  return { text: text.trim(), calls, steps, duration_ms: since() }
}
