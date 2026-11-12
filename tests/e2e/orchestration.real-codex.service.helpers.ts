import { execFile } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { collectProcessTree, parseProcessRows } from './agent.prompt.real-codex.daemon.processes'
import { seedWorkspaceState } from './workspace-canvas.helpers'

// E-03 helpers: a seeded pair of agent nodes linked by the user CLI, DB reads that survive the
// service restart, and the process-tree lookup that keeps kill -9 limited to app-servers of the
// app this test launched. No file of the personal Codex profile is read or written except the
// hashes the shared afterEach compares.

const exec = promisify(execFile)

export const serviceWorkspaceId = 'orch-real'
export const serviceSpaceId = 'orch-space'
export const serviceOrchestratorNodeId = 'orch-agent'
export const serviceExecutorNodeId = 'exec-alpha'
export const serviceExecutorTitle = 'alpha'

const directory = (workspace: string) => ({
  executionDirectory: workspace,
  expectedDirectory: workspace,
  directoryMode: 'workspace' as const,
  customDirectory: null,
  shouldCreateDirectory: false,
})

/** Seeds the orchestrator and executor agent nodes; `orch link create` starts the service. */
export async function seedServiceWorkspace(window: Page, workspace: string): Promise<void> {
  const location = directory(workspace)
  await seedWorkspaceState(window, {
    activeWorkspaceId: serviceWorkspaceId,
    settings: {
      defaultProvider: 'claude-code',
      agentFullAccess: true,
      customModelEnabledByProvider: { codex: false },
    },
    workspaces: [
      {
        id: serviceWorkspaceId,
        name: 'Orchestration service death',
        path: workspace,
        nodes: [
          {
            id: serviceOrchestratorNodeId,
            title: 'Orchestrator',
            kind: 'agent',
            status: null,
            startedAt: null,
            endedAt: null,
            exitCode: null,
            lastError: null,
            position: { x: 640, y: 80 },
            width: 460,
            height: 300,
            ...location,
            agent: {
              provider: 'claude-code',
              prompt: '',
              model: null,
              effectiveModel: null,
              launchMode: 'new',
              resumeSessionId: null,
              ...location,
            },
          },
          {
            id: serviceExecutorNodeId,
            title: serviceExecutorTitle,
            kind: 'agent',
            status: null,
            startedAt: null,
            endedAt: null,
            exitCode: null,
            lastError: null,
            position: { x: 100, y: 80 },
            width: 460,
            height: 300,
            ...location,
            agent: {
              provider: 'codex',
              prompt: '',
              model: null,
              effectiveModel: null,
              launchMode: 'new',
              resumeSessionId: null,
              ...location,
            },
          },
        ],
        spaces: [
          {
            id: serviceSpaceId,
            name: 'Orchestration space',
            directoryPath: workspace,
            nodeIds: [serviceOrchestratorNodeId, serviceExecutorNodeId],
            rect: { x: 60, y: 40, width: 1040, height: 760 },
          },
        ],
      },
    ],
  })
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Pids of `codex app-server` processes descending from the app root pid. */
export async function appServerPidsUnder(rootPid: number): Promise<number[]> {
  const { stdout } = await exec('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,sess=,command='], {
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return collectProcessTree(parseProcessRows(stdout, true), rootPid)
    .filter(row => /\bapp-server\b.*--ws-token-sha256/.test(row.command))
    .map(row => row.pid)
}

/** Kills one app-server pid only after proving it belongs to the app process tree. */
export async function killAppServerUnder(rootPid: number, pid: number): Promise<void> {
  const pids = await appServerPidsUnder(rootPid)
  if (!pids.includes(pid)) {
    throw new Error(`pid ${pid} is not an app-server under app ${rootPid}: ${pids.join(',')}`)
  }
  process.kill(pid, 'SIGKILL')
}

/** True when every pid is gone or only a zombie. */
export async function pidsGone(pids: number[]): Promise<boolean> {
  if (pids.length === 0) {
    return true
  }
  const result = await exec('ps', ['-o', 'pid=,stat=', '-p', pids.join(',')]).catch(() => ({
    stdout: '',
  }))
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .every(line => /^\s*\d+\s+Z/.test(line))
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Persisted `sessionId` of the node; the TUI binding rewrites it on every launch/relaunch. */
export async function nodeSessionId(window: Page, nodeId: string): Promise<string | null> {
  const raw = await window.evaluate(async () => {
    return await window.opencoveApi.persistence.readWorkspaceStateRaw()
  })
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as {
      workspaces?: Array<{ nodes?: Array<{ id?: string; sessionId?: unknown }> }>
    }
    for (const workspace of parsed.workspaces ?? []) {
      const node = workspace.nodes?.find(candidate => candidate.id === nodeId)
      if (node) {
        return typeof node.sessionId === 'string' && node.sessionId.length > 0
          ? node.sessionId
          : null
      }
    }
    return null
  } catch {
    return null
  }
}

export interface LinkRow {
  id: string
  executor_session_ref: string | null
  service_pid: number | null
  service_token_sha256: string | null
  state: string
  rounds_used: number
  rounds_limit: number
}

export interface DispatchRow {
  id: string
  state: string
  reason: string | null
  round: number
  turn_ref: string | null
}

export interface NoticeRow {
  id: string
  kind: string
  dispatch_id: string | null
  delivery_state: string
}

/** Rows of one query, or null while the database cannot be read yet (boot, hot journal). */
function readRows<T>(userDataDir: string, sql: string, params: (string | number)[]): T[] | null {
  try {
    const db = new DatabaseSync(path.join(userDataDir, 'opencove.db'), { readOnly: true })
    try {
      return db.prepare(sql).all(...params) as unknown as T[]
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export async function readLink(
  userDataDir: string,
  executorNodeId: string,
): Promise<LinkRow | null> {
  const rows = readRows<LinkRow>(
    userDataDir,
    `SELECT id, executor_session_ref, service_pid, service_token_sha256, state,
            rounds_used, rounds_limit
       FROM agent_links WHERE executor_node_id = ? AND state = 'active'`,
    [executorNodeId],
  )
  return rows?.[0] ?? null
}

export async function readDispatch(
  userDataDir: string,
  dispatchId: string,
): Promise<DispatchRow | null> {
  const rows = readRows<DispatchRow>(
    userDataDir,
    'SELECT id, state, reason, round, turn_ref FROM orchestration_dispatches WHERE id = ?',
    [dispatchId],
  )
  return rows?.[0] ?? null
}

export async function readNoticesForDispatch(
  userDataDir: string,
  dispatchId: string,
): Promise<NoticeRow[] | null> {
  return readRows<NoticeRow>(
    userDataDir,
    `SELECT id, kind, dispatch_id, delivery_state FROM orchestration_notices
      WHERE dispatch_id = ? ORDER BY created_at`,
    [dispatchId],
  )
}

export async function readNoticesForExecutor(
  userDataDir: string,
  executorNodeId: string,
): Promise<NoticeRow[] | null> {
  return readRows<NoticeRow>(
    userDataDir,
    `SELECT id, kind, dispatch_id, delivery_state FROM orchestration_notices
      WHERE executor_node_id = ? ORDER BY created_at`,
    [executorNodeId],
  )
}

/** `orch dispatch` prints the UUID on stderr before the Worker call. */
export function parseDispatchId(stderr: string): string {
  const match = /Dispatch ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
    stderr,
  )
  if (!match) {
    throw new Error(`dispatch id not found in CLI stderr: ${stderr}`)
  }
  return match[1]
}
