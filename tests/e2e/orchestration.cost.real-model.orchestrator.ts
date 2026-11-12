import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sse } from './agent.prompt.real-claude.helpers'
import type { CostExecutor } from './orchestration.cost.real-model.helpers'
import { measureNotice as measure, type CostNotice } from './orchestration.cost.real-model.tokens'
import type { ClaudeRequest } from './orchestration.real-codex.claude'
import { stepsInTurn, turnTextOf } from './orchestration.real-codex.claude'

// Scripted Claude Code orchestrator: spawn alpha and beta, dispatch alpha a second time after both
// first notices, then close the two links. The Messages API is fake, so this side costs zero; only
// the executors reach the real model.

export interface CostOrchestratorApi {
  server: Server
  url: string
  turns: () => string[]
  commands: () => string[]
  results: () => string[]
  notices: () => CostNotice[]
  setExecutorIds: (ids: Partial<Record<CostExecutor, string>>) => void
}

const asText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map(block =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text?: unknown }).text ?? '')
          : '',
      )
      .join('\n')
  }
  return content === undefined ? '' : JSON.stringify(content)
}

const jsonObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

const labelsOf = (text: string): Set<string> =>
  new Set(
    text
      .split('\n')
      .filter(line => line.startsWith('- '))
      .map(line => line.slice(2).split(' ')[0] ?? ''),
  )

const bash = (command: string) => ({
  type: 'tool_use',
  id: `toolu_${Math.random().toString(36).slice(2)}`,
  name: 'Bash',
  input: { command, description: 'Run the OpenCove orchestration CLI' },
})

const say = (text: string) => ({ type: 'text', text }) as const

export async function startCostOrchestratorApi(): Promise<CostOrchestratorApi> {
  const turns: string[] = []
  const commands: string[] = []
  const results: string[] = []
  const notices: CostNotice[] = []
  const executorIds: Partial<Record<CostExecutor, string>> = {}
  let secondSent = false
  let dispatchNoticeTurn = -1
  let noticeTurn = 0
  let closing = false

  const reply = (
    res: ServerResponse,
    body: ClaudeRequest,
    text: string,
    stopReason: 'tool_use' | 'end_turn',
    command?: string,
  ) => {
    const model = body.model ?? 'claude-test'
    const id = `msg_${Date.now()}`
    const block = command ? bash(command) : say(text)
    if (command) {
      commands.push(command)
    }
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
        delta: command
          ? { type: 'input_json_delta', partial_json: JSON.stringify({ command }) }
          : { type: 'text_delta', text },
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

  const run = (res: ServerResponse, body: ClaudeRequest, command: string) =>
    reply(res, body, '', 'tool_use', command)

  const promptOf = (messages: ClaudeRequest['messages']): string => turnTextOf(messages ?? [])

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
    if (!(body.tools ?? []).some(tool => tool.name === 'Bash')) {
      reply(res, body, 'ACK', 'end_turn')
      return
    }
    const text = promptOf(messages)
    turns.push(text)
    const steps = stepsInTurn(messages)
    const lastResult = messages
      .flatMap(message => (typeof message.content === 'string' ? [] : message.content))
      .filter(
        (block): block is { type: 'tool_result'; content?: unknown } =>
          block.type === 'tool_result',
      )
      .at(-1)
    const lastText = asText(lastResult?.content)
    if (lastResult) {
      results.push(lastText)
    }
    if (text.includes('[glimpse]')) {
      if (steps === 0) {
        noticeTurn += 1
        notices.push(measure(text))
      }
      const labels = new Set(notices.flatMap(notice => [...labelsOf(notice.text)]))
      if (!secondSent && executorIds.alpha && labels.has('alpha') && labels.has('beta')) {
        if (steps === 0) {
          secondSent = true
          dispatchNoticeTurn = noticeTurn
          run(
            res,
            body,
            `opencove orch dispatch --to "${executorIds.alpha}" --text "E04_ALPHA_2 responda apenas OK"`,
          )
          return
        }
        reply(res, body, 'ORCH_WAITING', 'end_turn')
        return
      }
      if (secondSent) {
        if (noticeTurn <= dispatchNoticeTurn || !labelsOf(text).has('alpha')) {
          reply(res, body, 'ORCH_WAITING', 'end_turn')
          return
        }
        if (!closing) {
          closing = true
        }
        if (steps === 0) {
          run(res, body, `opencove orch close --to "${executorIds.alpha}"`)
          return
        }
        if (steps === 1 && executorIds.beta) {
          run(res, body, `opencove orch close --to "${executorIds.beta}"`)
          return
        }
        reply(res, body, 'ORCH_DONE', 'end_turn')
        return
      }
      reply(res, body, 'ORCH_WAITING', 'end_turn')
      return
    }
    if (steps === 0) {
      const alpha = executorIds.alpha
      run(
        res,
        body,
        alpha
          ? `opencove orch dispatch --to "${alpha}" --text "E04_ALPHA_2 responda apenas OK"`
          : 'opencove orch spawn --provider codex --title alpha --prompt "E04_ALPHA_1 responda apenas OK" -o json',
      )
      return
    }
    if (steps === 1) {
      const parsed = jsonObject(lastText)
      if (typeof parsed?.['executorNodeId'] === 'string') {
        executorIds.alpha = parsed['executorNodeId']
      }
      run(
        res,
        body,
        'opencove orch spawn --provider codex --title beta --prompt "E04_BETA_1 responda apenas OK" -o json',
      )
      return
    }
    if (steps === 2) {
      const parsed = jsonObject(lastText)
      if (typeof parsed?.['executorNodeId'] === 'string') {
        executorIds.beta = parsed['executorNodeId']
      }
    }
    reply(res, body, 'ORCH_WAITING', 'end_turn')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    turns: () => [...turns],
    commands: () => [...commands],
    results: () => [...results],
    notices: () => [...notices],
    setExecutorIds: ids => {
      Object.assign(executorIds, ids)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Token truth: `threads` in the Codex state DB maps executor -> thread id, and the rollout JSONL
// under ~/.codex/sessions carries `token_usage_record` per model request. Read-only.
