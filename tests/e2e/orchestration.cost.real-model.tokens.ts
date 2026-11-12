import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { CostExecutor, CostMode } from './orchestration.cost.real-model.helpers'

// Token truth for E-04: `threads` in the Codex state DB maps executor -> thread id, and the rollout
// JSONL under ~/.codex/sessions carries `token_usage_record` per model request. Read-only; nothing
// under ~/.codex is created, changed or removed by this module.

const exec = promisify(execFile)

export interface CostNotice {
  text: string
  chars: number
  bytes: number
  lines: number
}

export const measureNotice = (text: string): CostNotice => ({
  text,
  chars: [...text].length,
  bytes: Buffer.byteLength(text, 'utf8'),
  lines: text.split('\n').filter(line => line.startsWith('- ')).length,
})

async function codexStateDbPath(codexHome: string): Promise<string> {
  const entries = await readdir(codexHome).catch(() => [] as string[])
  const states = entries
    .map(name => ({ name, match: /^state_(\d+)\.sqlite$/.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
  const newest = states.at(-1)
  if (!newest) {
    throw new Error(`No Codex state DB under ${codexHome}`)
  }
  return path.join(codexHome, newest.name)
}

export interface CodexThreadRow {
  id: string
  name: string | null
  cwd: string
  createdAt: number
}

export async function readGlimpseThreads(
  codexHome: string,
  workspace: string,
  sinceMs: number,
): Promise<CodexThreadRow[]> {
  const db = new DatabaseSync(await codexStateDbPath(codexHome), { readOnly: true })
  try {
    return db
      .prepare(
        'select id, name, cwd, created_at as createdAt from threads where cwd = ? and created_at >= ? and name like ?',
      )
      .all(workspace, Math.floor(sinceMs / 1000), 'Glimpse: %') as unknown as CodexThreadRow[]
  } finally {
    db.close()
  }
}

export interface TurnUsage {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  reasoning: number
  requests: number
}

export interface ParsedTurn {
  turnId: string
  prompt: string
  usage: TurnUsage
}

export interface ParsedRollout {
  threadId: string
  cliVersion: string
  model: string
  provider: string
  turns: ParsedTurn[]
}

interface CodexEvent {
  type: string
  payload?: Record<string, unknown>
}

/** Parses one rollout JSONL: prompts from UserMessage items, usage from the last turn snapshot. */
export async function parseRollout(file: string, threadId: string): Promise<ParsedRollout> {
  const raw = await readFile(file, 'utf8')
  const prompts = new Map<string, string>()
  const usage = new Map<string, TurnUsage>()
  let cliVersion = ''
  let model = ''
  let provider = ''
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let event: CodexEvent
    try {
      event = JSON.parse(line) as CodexEvent
    } catch {
      continue
    }
    const payload = event.payload ?? {}
    if (event.type === 'session_meta') {
      cliVersion = String(payload['cli_version'] ?? '')
      provider = String(payload['model_provider'] ?? '')
    }
    if (event.type === 'turn_context') {
      model = String(payload['model'] ?? model)
    }
    if (event.type === 'event_msg' && payload['type'] === 'item_completed') {
      const item = payload['item'] as
        | { type?: string; content?: Array<{ text?: string }> }
        | undefined
      const turnId = String(payload['turn_id'] ?? '')
      if (item?.type === 'UserMessage' && turnId) {
        prompts.set(turnId, item.content?.map(block => block.text ?? '').join('\n') ?? '')
      }
    }
    if (event.type === 'token_usage_record') {
      const turnId = String(payload['turn_id'] ?? '')
      const snapshot = payload['turn_token_usage'] as Record<string, number> | undefined
      const current = usage.get(turnId)
      usage.set(turnId, {
        input: Number(snapshot?.['input_tokens'] ?? 0),
        cacheWrite: Number(snapshot?.['cache_write_input_tokens'] ?? 0),
        cacheRead: Number(snapshot?.['cached_input_tokens'] ?? 0),
        output: Number(snapshot?.['output_tokens'] ?? 0),
        reasoning: Number(snapshot?.['reasoning_output_tokens'] ?? 0),
        requests: (current?.requests ?? 0) + 1,
      })
    }
  }
  return {
    threadId,
    cliVersion,
    model,
    provider,
    turns: [...usage.entries()]
      .filter(([turnId]) => prompts.has(turnId))
      .map(([turnId, turnUsage]) => ({
        turnId,
        prompt: prompts.get(turnId) ?? '',
        usage: turnUsage,
      })),
  }
}

/** Newest rollout file of a thread: archived on `orch close`, otherwise in today's date tree. */
export async function findRolloutFile(codexHome: string, threadId: string): Promise<string> {
  const archived = await readdir(path.join(codexHome, 'archived_sessions')).catch(
    () => [] as string[],
  )
  const archivedMatch = archived.find(name => name.includes(threadId))
  if (archivedMatch) {
    return path.join(codexHome, 'archived_sessions', archivedMatch)
  }
  const now = new Date()
  const day = path.join(
    codexHome,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  )
  const names = await readdir(day).catch(() => [] as string[])
  const match = names.find(name => name.includes(threadId))
  if (!match) {
    throw new Error(`No rollout file for thread ${threadId} under ${day}`)
  }
  return path.join(day, match)
}

export interface CostReportTurn extends TurnUsage {
  executor: CostExecutor
  dispatch: number
  prompt: string
  derivedCacheWrite: number
}

export interface CostReport {
  mode: CostMode
  cliVersion: string
  model: string
  provider: string
  dispatches: number
  turns: CostReportTurn[]
  notices: CostNotice[]
  threadIds: Record<CostExecutor, string>
  warnings: string[]
}

/** Builds the E-04 report; asserts nothing so a bad run still leaves the numbers in the log. */
export async function buildCostReport(input: {
  mode: CostMode
  codexHome: string
  workspace: string
  sinceMs: number
  notices: CostNotice[]
  executorIds: Record<CostExecutor, string>
}): Promise<CostReport> {
  const threads = await readGlimpseThreads(input.codexHome, input.workspace, input.sinceMs)
  const byExecutor = Object.fromEntries(
    Object.entries(input.executorIds).map(([executor, nodeId]) => [
      executor,
      threads.find(thread => thread.name === `Glimpse: ${nodeId}`),
    ]),
  ) as Record<CostExecutor, CodexThreadRow | undefined>
  const turns: CostReportTurn[] = []
  const threadIds: Partial<Record<CostExecutor, string>> = {}
  const warnings: string[] = []
  let cliVersion = ''
  let model = ''
  let provider = ''
  const parsed = await Promise.all(
    (['alpha', 'beta'] as const).map(async executor => {
      const thread = byExecutor[executor]
      if (!thread) {
        warnings.push(`no Glimpse thread for ${executor} (${input.executorIds[executor]})`)
        return null
      }
      try {
        return {
          executor,
          threadId: thread.id,
          rollout: await parseRollout(await findRolloutFile(input.codexHome, thread.id), thread.id),
        }
      } catch (error) {
        warnings.push(`rollout of ${executor} failed: ${String(error)}`)
        return null
      }
    }),
  )
  for (const item of parsed) {
    if (!item) {
      continue
    }
    threadIds[item.executor] = item.threadId
    cliVersion = item.rollout.cliVersion || cliVersion
    model = item.rollout.model || model
    provider = item.rollout.provider || provider
    item.rollout.turns.forEach((turn, index) => {
      if (!turn.prompt.includes('E04_')) {
        return
      }
      turns.push({
        executor: item.executor,
        dispatch: index + 1,
        prompt: turn.prompt,
        ...turn.usage,
        derivedCacheWrite: Math.max(0, turn.usage.input - turn.usage.cacheRead),
      })
    })
  }
  return {
    mode: input.mode,
    cliVersion,
    model,
    provider,
    dispatches: turns.length,
    turns,
    notices: input.notices,
    threadIds: threadIds as Record<CostExecutor, string>,
    warnings,
  }
}

/** Pids of `codex app-server` descending from the app root pid, for the shutdown gate. */
export async function appServerPidsUnder(rootPid: number): Promise<number[]> {
  const { stdout } = await exec('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,sess=,command='], {
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return collectDescendants(parseRows(stdout), rootPid)
    .filter(row => /\bapp-server\b.*--ws-token-sha256/.test(row.command))
    .map(row => row.pid)
}

interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

function parseRows(stdout: string): ProcessRow[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const fields = line.split(/\s+/)
      return { pid: Number(fields[0]), ppid: Number(fields[1]), command: fields.slice(4).join(' ') }
    })
}

function collectDescendants(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  }
  const out: ProcessRow[] = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    for (const child of children.get(pid) ?? []) {
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}
