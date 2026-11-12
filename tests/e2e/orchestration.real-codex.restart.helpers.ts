import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { collectProcessTree, parseProcessRows } from './agent.prompt.real-codex.daemon.processes'
import { orchestratorNodeId } from './orchestration.real-codex.helpers'

// Reads that survive the SIGKILL restart of E-02: the old app-server pids are found by walking
// the process tree before the crash, and the app database is opened read-only, like E-01 does with
// the Codex profile database.

const exec = promisify(execFile)

export interface OrchestratorBinding {
  resumeSessionId: string | null
  resumeSessionIdVerified: boolean
}

export interface AgentSnapshot {
  sessionId: string
  state: string
  quality: string
  source: string | null
}

export async function readOrchestratorSnapshot(window: Page): Promise<AgentSnapshot | null> {
  return await window.evaluate(async nodeId => {
    return await window.opencoveApi.controlSurface.invoke<AgentSnapshot | null>({
      kind: 'query',
      id: 'agent.get',
      payload: { nodeId },
    })
  }, orchestratorNodeId)
}

export async function readOrchestratorBinding(window: Page): Promise<OrchestratorBinding> {
  const raw = await window.evaluate(async () => {
    return await window.opencoveApi.persistence.readWorkspaceStateRaw()
  })
  const empty: OrchestratorBinding = { resumeSessionId: null, resumeSessionIdVerified: false }
  if (!raw) {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as {
      workspaces?: Array<{
        nodes?: Array<{
          id?: string
          agent?: {
            resumeSessionId?: string | null
            resumeSessionIdVerified?: boolean
          } | null
        }>
      }>
    }
    for (const workspace of parsed.workspaces ?? []) {
      const node = workspace.nodes?.find(candidate => candidate.id === orchestratorNodeId)
      if (node) {
        return {
          resumeSessionId: node.agent?.resumeSessionId ?? null,
          resumeSessionIdVerified: node.agent?.resumeSessionIdVerified === true,
        }
      }
    }
    return empty
  } catch {
    return empty
  }
}

async function appServerPidsUnder(rootPid: number): Promise<number[]> {
  const { stdout } = await exec('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,sess=,command='], {
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return collectProcessTree(parseProcessRows(stdout, true), rootPid)
    .filter(row => /\bapp-server\b.*--ws-token-sha256/.test(row.command))
    .map(row => row.pid)
}

/** True when every pid is gone or only a zombie; the ps call itself never throws on ENOENT. */
async function pidsGone(pids: number[]): Promise<boolean> {
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** `pid` of the Worker that the app owns, from its control surface connection file. */
async function workerPidOf(userDataDir: string): Promise<number | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(userDataDir, 'worker-control-surface.json'), 'utf8'),
    ) as { pid?: unknown }
    return typeof raw.pid === 'number' ? raw.pid : null
  } catch {
    return null
  }
}

export interface LinkRow {
  executor_session_ref: string | null
  service_pid: number | null
  service_token_sha256: string | null
  state: string
}

export interface DispatchRow {
  id: string
  state: string
  reason: string | null
  turn_ref: string | null
  glimpse_turn_id: string | null
  outcome: string | null
}

export interface NoticeRow {
  id: string
  kind: string
  dispatch_id: string | null
  delivery_state: string
  batch_id: string | null
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
    `SELECT executor_session_ref, service_pid, service_token_sha256, state
       FROM agent_links WHERE executor_node_id = ? AND state = 'active'`,
    [executorNodeId],
  )
  return rows?.[0] ?? null
}

/** Every dispatch of the executor, newest first. */
export async function readDispatches(
  userDataDir: string,
  executorNodeId: string,
): Promise<DispatchRow[] | null> {
  return readRows<DispatchRow>(
    userDataDir,
    `SELECT id, state, reason, turn_ref, glimpse_turn_id, outcome
       FROM orchestration_dispatches WHERE executor_node_id = ?
       ORDER BY created_at DESC, round DESC`,
    [executorNodeId],
  )
}

export async function readNoticesForDispatch(
  userDataDir: string,
  dispatchId: string,
): Promise<NoticeRow[] | null> {
  return readRows<NoticeRow>(
    userDataDir,
    `SELECT id, kind, dispatch_id, delivery_state, batch_id
       FROM orchestration_notices WHERE dispatch_id = ? ORDER BY created_at`,
    [dispatchId],
  )
}

export { appServerPidsUnder, pidsGone, processAlive, workerPidOf }
