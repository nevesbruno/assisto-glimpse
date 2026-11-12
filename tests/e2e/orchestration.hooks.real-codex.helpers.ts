import { spawn, execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import {
  collectProcessTree,
  parseProcessRows,
  type ProcessRow,
} from './agent.prompt.real-codex.daemon.processes'
import { cli } from './agent.prompt.real-codex.helpers'
import { seedWorkspaceState } from './workspace-canvas.helpers'

// E-06 helpers: a scratch marker pair, the `-c` PreToolUse override the wrapper applies to every
// Codex process the app launches, a hooks/list probe with that same wrapper, and the product
// surface reads (`orch status`, `orch link create/close`). Nothing here writes under ~/.codex.

const exec = promisify(execFile)

export const hooksWorkspaceId = 'orch-hooks'
export const hooksOrchestratorNodeId = 'hooks-orchestrator'
export const hooksExecutorNodeId = 'hooks-executor'
/** Same text for every turn, so "o mesmo turno" means the same task content. */
export const hooksTaskText = 'EXEC_TASK hooked HOOKED'

export interface HookScratch {
  root: string
  marker: string
  markerAlt: string
  dispose: () => Promise<void>
}

export async function createHookScratch(): Promise<HookScratch> {
  const root = await mkdtemp(path.join(tmpdir(), 'opencove-orch-hooks-'))
  return {
    root,
    marker: path.join(root, 'hook-marker'),
    markerAlt: path.join(root, 'hook-marker-altered'),
    dispose: async () => {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

/** One PreToolUse command hook, injected through `-c` by the fixture wrapper. */
export function preToolUseHook(markerPath: string): string {
  return `hooks.PreToolUse=[{hooks=[{type="command",command="printf hit >> ${markerPath}",timeout=3}]}]`
}

/** Rewrites only the fixture wrapper, never the personal profile. */
export async function rewriteHookMarker(
  wrapperDir: string,
  from: string,
  to: string,
): Promise<void> {
  const wrapperPath = path.join(wrapperDir, 'codex')
  const current = await readFile(wrapperPath, 'utf8')
  if (!current.includes(from)) {
    throw new Error(`wrapper does not carry the hook marker ${from}`)
  }
  await writeFile(wrapperPath, current.replaceAll(from, to))
}

const directory = (workspace: string) => ({
  executionDirectory: workspace,
  expectedDirectory: workspace,
  directoryMode: 'workspace' as const,
  customDirectory: null,
  shouldCreateDirectory: false,
})

/** Seeds the orchestrator and executor agent nodes; the user CLI links them. */
export async function seedHooksWorkspace(window: Page, workspace: string): Promise<void> {
  const location = directory(workspace)
  await seedWorkspaceState(window, {
    activeWorkspaceId: hooksWorkspaceId,
    settings: {
      defaultProvider: 'claude-code',
      agentFullAccess: true,
      customModelEnabledByProvider: { codex: false },
    },
    workspaces: [
      {
        id: hooksWorkspaceId,
        name: 'Orchestration hooks',
        path: workspace,
        nodes: [
          {
            id: hooksOrchestratorNodeId,
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
              prompt: 'Orchestrator stub; the user CLI drives the executor.',
              model: null,
              effectiveModel: null,
              launchMode: 'new',
              resumeSessionId: null,
              ...location,
            },
          },
          {
            id: hooksExecutorNodeId,
            title: 'hooked',
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
              prompt: 'Executor driven by the user CLI.',
              model: null,
              effectiveModel: null,
              launchMode: 'new',
              resumeSessionId: null,
              ...location,
            },
          },
        ],
        spaces: [],
      },
    ],
  })
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function createLink(
  userDataDir: string,
  orchestratorNodeId: string,
  executorNodeId: string,
): Promise<{ exitCode: number; linkId: string | null; raw: string }> {
  const result = await cli(userDataDir, [
    'orch',
    'link',
    'create',
    '--orchestrator',
    orchestratorNodeId,
    '--executor',
    executorNodeId,
  ])
  const raw = `${result.stdout}\n${result.stderr}`
  const linkId =
    raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null
  return { exitCode: result.exitCode, linkId, raw }
}

export async function closeLink(userDataDir: string, linkId: string): Promise<CommandResult> {
  return await cli(userDataDir, ['orch', 'link', 'close', '--link', linkId])
}

export async function dispatchTurn(userDataDir: string, text: string): Promise<CommandResult> {
  return await cli(userDataDir, ['orch', 'dispatch', '--to', hooksExecutorNodeId, '--text', text])
}

export async function approveHooks(userDataDir: string, key: string): Promise<CommandResult> {
  return await cli(userDataDir, [
    'orch',
    'hooks',
    'approve',
    '--to',
    hooksExecutorNodeId,
    '--key',
    key,
  ])
}

export interface StatusLink {
  executorNodeId: string
  health: string
  pendingHooks: number
  current: { state: string } | null
  last: { state: string; reason: string | null } | null
}

/** One link from `orch status -o json`, or null while the link is absent. */
export async function readStatus(
  userDataDir: string,
  executorNodeId = hooksExecutorNodeId,
): Promise<StatusLink | null> {
  const result = await cli(userDataDir, ['orch', 'status', '--to', executorNodeId, '-o', 'json'])
  if (result.exitCode !== 0) {
    return null
  }
  try {
    const parsed = JSON.parse(result.stdout) as { links?: StatusLink[] }
    return parsed.links?.[0] ?? null
  } catch {
    return null
  }
}

export interface ListedHook {
  key: string
  eventName: string
  command?: string
  currentHash: string
  trustStatus: string
  source: string
  enabled: boolean
}

interface HooksListResponse {
  data?: Array<{ cwd?: string; hooks?: ListedHook[] }>
}

const personalCodexHome = (): string => process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex')

/**
 * Runs `hooks/list` through the fixture wrapper, so the listed entries carry exactly the `-c`
 * overrides the executor service receives. The probe only reads the profile.
 */
export async function listSessionHooks(input: {
  wrapperDir: string
  cwd: string
}): Promise<ListedHook[]> {
  const executable = path.join(input.wrapperDir, 'codex')
  return await new Promise<ListedHook[]>((resolve, reject) => {
    const child = spawn(executable, ['app-server'], {
      env: { ...process.env, CODEX_HOME: personalCodexHome() },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let errorOutput = ''
    let settled = false
    let timeout: NodeJS.Timeout | null = null
    const finish = (error?: Error, hooks?: ListedHook[]): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      child.stdin.end()
      child.kill()
      if (error) {
        reject(error)
      } else {
        resolve(hooks ?? [])
      }
    }
    timeout = setTimeout(
      () => finish(new Error(`hooks/list timed out: ${errorOutput.slice(-2_000)}`)),
      20_000,
    )
    child.once('error', error => finish(error))
    child.once('exit', (code, signal) => {
      finish(new Error(`app-server exited before hooks/list (${String(code ?? signal)})`))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (errorOutput.length < 16_000) {
        errorOutput += chunk
      }
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      let newline = output.indexOf('\n')
      while (newline >= 0) {
        const line = output.slice(0, newline).trim()
        output = output.slice(newline + 1)
        newline = output.indexOf('\n')
        if (!line) {
          continue
        }
        let message: { id?: number; result?: unknown; error?: unknown }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
          child.stdin.write(
            `${JSON.stringify({
              id: 2,
              method: 'hooks/list',
              params: { cwds: [input.cwd] },
            })}\n`,
          )
        } else if (message.id === 2) {
          if (message.error !== undefined) {
            finish(new Error(`hooks/list rejected: ${JSON.stringify(message.error)}`))
            return
          }
          const response = message.result as HooksListResponse
          finish(
            undefined,
            (response.data ?? []).flatMap(entry => entry.hooks ?? []),
          )
        }
      }
    })
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'opencove-e2e', title: 'OpenCove e2e', version: '0.0.0' } },
      })}\n`,
    )
  })
}

/** `codex app-server` rows descending from the app root pid, with the full command line. */
export async function appServerRowsUnder(rootPid: number): Promise<ProcessRow[]> {
  const { stdout } = await exec('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,sess=,command='], {
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const rows = collectProcessTree(parseProcessRows(stdout, true), rootPid)
  return rows.filter(row => /\bapp-server\b.*--ws-token-sha256/.test(row.command))
}

/** True when every pid is gone or only a zombie; ps never throws on a vanished process. */
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
