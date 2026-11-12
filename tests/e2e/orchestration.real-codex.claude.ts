import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { sse } from './agent.prompt.real-claude.helpers'

// Scripted Messages API for the real Claude Code orchestrator (diagnostic test provider). The
// orchestrator script lives in the latest user turn: the fake answers with one Bash tool_use per
// step and never calls a model.

export type ClaudeBlock =
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown }
export type ClaudeMessage = { role: string; content: string | ClaudeBlock[] }
export type ClaudeRequest = {
  stream?: boolean
  model?: string
  tools?: Array<{ name?: string }>
  messages?: ClaudeMessage[]
}

export interface ClaudeOrchestratorApi {
  server: Server
  url: string
  turns: () => string[]
  commands: () => string[]
  results: () => string[]
  /** Node ids for `orch close`, keyed by executor title: `--to` only matches ids, not titles. */
  setCloseTargets: (targets: Record<string, string>) => void
}

const blocksOf = (message: ClaudeMessage): ClaudeBlock[] =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content

const isTurnMessage = (message: ClaudeMessage): boolean =>
  message.role === 'user' && !blocksOf(message).some(block => block.type === 'tool_result')

export function turnTextOf(messages: ClaudeMessage[]): string {
  const turn = messages.filter(isTurnMessage).at(-1)
  return turn
    ? blocksOf(turn)
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n')
    : ''
}

/** Tool results already returned inside the current user turn. */
export function stepsInTurn(messages: ClaudeMessage[]): number {
  let lastTurn = -1
  messages.forEach((message, index) => {
    if (isTurnMessage(message)) {
      lastTurn = index
    }
  })
  return messages
    .slice(lastTurn + 1)
    .flatMap(blocksOf)
    .filter(block => block.type === 'tool_result').length
}

function claudeReply(
  res: ServerResponse,
  body: ClaudeRequest,
  block: ClaudeBlock,
  stopReason: 'tool_use' | 'end_turn',
): void {
  const model = body.model ?? 'claude-test'
  const id = `msg_${Date.now()}`
  sse(res, [
    {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: block },
    {
      type: 'content_block_delta',
      index: 0,
      delta:
        block.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }
          : { type: 'text_delta', text: block.text ?? '' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ])
}

const bash = (command: string): ClaudeBlock => ({
  type: 'tool_use',
  id: `toolu_${Math.random().toString(36).slice(2)}`,
  name: 'Bash',
  input: { command, description: 'Run the OpenCove orchestration CLI' },
})

/** Drives the same orchestration script as the Codex fake, for a real Claude Code CLI. */
export async function startClaudeOrchestratorApi(): Promise<ClaudeOrchestratorApi> {
  const turns: string[] = []
  const commands: string[] = []
  const results: string[] = []
  let closeTargets: Record<string, string> = {}
  const run = (res: ServerResponse, body: ClaudeRequest, command: string) => {
    commands.push(command)
    claudeReply(res, body, bash(command), 'tool_use')
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const url = req.url ?? ''
    if (req.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 12 }))
      return
    }
    if (!(req.method === 'POST' && url.startsWith('/v1/messages'))) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ClaudeRequest
    const messages = body.messages ?? []
    const main = (body.tools ?? []).some(tool => tool.name === 'Bash')
    if (!main) {
      claudeReply(res, body, { type: 'text', text: 'ACK' }, 'end_turn')
      return
    }
    const text = turnTextOf(messages)
    turns.push(text)
    const lastResult = messages
      .flatMap(blocksOf)
      .filter(block => block.type === 'tool_result')
      .at(-1)
    if (lastResult) {
      results.push(
        typeof lastResult.content === 'string'
          ? lastResult.content
          : JSON.stringify(lastResult.content ?? ''),
      )
    }
    const steps = stepsInTurn(messages)
    if (text.includes('[glimpse]')) {
      const reads = [...text.matchAll(/ler: (opencove agent read --node (.+?) --turn \S+)/g)]
      if (steps < reads.length) {
        run(res, body, reads[steps][1])
        return
      }
      if (steps < reads.length * 2) {
        const name = reads[steps - reads.length][2]
        run(res, body, `opencove orch close --to "${closeTargets[name] ?? name}"`)
        return
      }
      claudeReply(res, body, { type: 'text', text: 'ORCH_DONE' }, 'end_turn')
      return
    }
    const spawn = text.match(/ORCH_SPAWN (.+)/)?.[1]
    if (spawn) {
      const labels = spawn.split(/\s+/).filter(Boolean)
      if (steps < labels.length) {
        const [label, ...flags] = labels[steps].split(':')
        const task = `EXEC_TASK ${label} ${flags.join(' ')}`.trim()
        claudeReply(
          res,
          body,
          bash(`opencove orch spawn --provider codex --title "${label}" --prompt "${task}"`),
          'tool_use',
        )
        return
      }
      claudeReply(res, body, { type: 'text', text: 'ORCH_WAITING' }, 'end_turn')
      return
    }
    claudeReply(res, body, { type: 'text', text: 'ACK' }, 'end_turn')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    turns: () => [...turns],
    commands: () => [...commands],
    results: () => [...results],
    setCloseTargets: targets => {
      closeTargets = { ...closeTargets, ...targets }
    },
  }
}

export async function createClaudeTestProfile(
  root: string,
  workspace: string,
  baseUrl: string,
): Promise<Record<string, string>> {
  const configDir = path.join(root, 'claude-config')
  await mkdir(configDir, { recursive: true })
  const apiKey = 'opencove-local-claude-diagnostic-not-a-real-key'
  await writeFile(
    path.join(configDir, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      hasSeenAutoDefaultNotice: true,
      hasSeenAutoModeEntryWarning: true,
      hasSeenAutoModeOutsideReadPrompt: true,
      // `--dangerously-skip-permissions` would otherwise stop on its one-time dialog.
      bypassPermissionsModeAccepted: true,
      customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
      projects: { [workspace]: { hasTrustDialogAccepted: true } },
    }),
  )
  await writeFile(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ skipDangerousModePermissionPrompt: true }),
  )
  return {
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CONFIG_DIR: configDir,
    // Claude Code skips its bypass-permissions modal inside a sandbox (the e2e is one).
    IS_SANDBOX: '1',
    OPENCOVE_TEST_CLAUDE_HOOK_INSTALL_FAILURE: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}
