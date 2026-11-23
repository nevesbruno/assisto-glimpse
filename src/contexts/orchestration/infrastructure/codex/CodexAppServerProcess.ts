/* eslint-disable no-await-in-loop -- start attempts and readiness polling are sequential by design. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import type { PortReserver } from '../../application/ports/hostPorts'
import type { ExecutorRuntimeError } from '../../application/ports/executorRuntime'
import type { ServiceExit } from '../process/ExecutorProcessSupervisor'
import { buildCodexAppServerArgs, type CodexHookTrust } from './codexProcessEnv'

export const START_ATTEMPTS = 3
export const READINESS_TIMEOUT_MS = 10_000
export const READINESS_POLL_MS = 100
export const TERM_GRACE_MS = 3000
const STDERR_TAIL_CHARS = 2000

export interface AppServerChild {
  readonly pid?: number
  readonly stderr?: NodeJS.ReadableStream | null
  once: {
    (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
    (event: 'error', listener: (error: Error) => void): unknown
  }
}

export interface CodexAppServerDeps {
  portReserver: PortReserver
  spawnChild: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) => AppServerChild
  checkReady: (port: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  now: () => number
  killGroup: (pid: number, signal: NodeJS.Signals) => void
  randomToken: () => string
}

export interface CodexAppServerStartInput {
  readonly executablePath: string
  readonly cwd: string
  /** Complete environment of the child, already filtered by `buildCodexProcessEnv`. */
  readonly env: Record<string, string>
  readonly hookTrust: readonly CodexHookTrust[]
}

export interface CodexAppServerProcess {
  readonly pid: number
  readonly port: number
  readonly url: string
  /** Only in memory: the command line carries the SHA-256 and nothing else. */
  readonly token: string
  /** SHA-256 hex of `token`, the same value the command line carries. */
  readonly tokenSha256: string
  readonly exited: Promise<ServiceExit>
  close: () => Promise<void>
}

function startError(message: string): ExecutorRuntimeError {
  return Object.assign(new Error(message), { code: 'executor.start_failed' as const })
}

const realDeps = (portReserver: PortReserver): CodexAppServerDeps => ({
  portReserver,
  spawnChild: (command, args, options) =>
    spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    }),
  checkReady: async port => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(500),
      })
      return response.status === 200
    } catch {
      return false
    }
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
  killGroup: (pid, signal) => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, signal)
    } catch {
      // The group is already gone.
    }
  },
  randomToken: () => randomBytes(32).toString('base64url'),
})

interface Attempt {
  child: AppServerChild
  pid: number
  exited: Promise<ServiceExit>
  isExited: () => boolean
  stderrTail: () => string
}

function spawnAttempt(
  deps: CodexAppServerDeps,
  command: string,
  args: string[],
  input: CodexAppServerStartInput,
): Attempt {
  const child = deps.spawnChild(command, args, { cwd: input.cwd, env: input.env })
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS)
  })
  let hasExited = false
  const exited = new Promise<ServiceExit>(resolve => {
    const finish = (exit: ServiceExit): void => {
      hasExited = true
      resolve(exit)
    }
    child.once('exit', (code, signal) => finish({ code, signal }))
    child.once('error', () => finish({ code: null, signal: null }))
  })
  return { child, pid: child.pid ?? -1, exited, isExited: () => hasExited, stderrTail: () => tail }
}

async function waitReady(
  deps: CodexAppServerDeps,
  port: number,
  attempt: Attempt,
): Promise<boolean> {
  const deadline = deps.now() + READINESS_TIMEOUT_MS
  while (deps.now() < deadline) {
    if (attempt.isExited()) {
      return false
    }
    if (await deps.checkReady(port)) {
      return !attempt.isExited()
    }
    await deps.sleep(READINESS_POLL_MS)
  }
  return false
}

async function closeAttempt(deps: CodexAppServerDeps, attempt: Attempt): Promise<void> {
  if (attempt.isExited() || attempt.pid < 0) {
    return
  }
  deps.killGroup(attempt.pid, 'SIGTERM')
  const outcome = await Promise.race([
    attempt.exited.then(() => 'exited' as const),
    deps.sleep(TERM_GRACE_MS).then(() => 'timeout' as const),
  ])
  if (outcome === 'timeout') {
    deps.killGroup(attempt.pid, 'SIGKILL')
    await attempt.exited
  }
}

/**
 * Starts `codex app-server` on a loopback port with a fresh capability token and waits for
 * `/readyz`. Up to 3 attempts on a new port when the process dies or never becomes ready.
 */
export async function startCodexAppServer(
  input: CodexAppServerStartInput,
  portReserver: PortReserver,
  overrides: Partial<CodexAppServerDeps> = {},
): Promise<CodexAppServerProcess> {
  const deps = { ...realDeps(portReserver), ...overrides }
  let lastFailure = 'unknown'
  for (let index = 0; index < START_ATTEMPTS; index += 1) {
    const port = await deps.portReserver.reserveLoopbackPort()
    const token = deps.randomToken()
    const tokenSha256 = createHash('sha256').update(token).digest('hex')
    const args = buildCodexAppServerArgs({
      port,
      tokenSha256,
      cwd: input.cwd,
      hookTrust: input.hookTrust,
    })
    const attempt = spawnAttempt(deps, input.executablePath, args, input)
    if (await waitReady(deps, port, attempt)) {
      const close = (): Promise<void> => closeAttempt(deps, attempt)
      return {
        pid: attempt.pid,
        port,
        url: `ws://127.0.0.1:${port}`,
        token,
        tokenSha256,
        exited: attempt.exited,
        close,
      }
    }
    lastFailure = attempt.stderrTail().replaceAll(token, '[redacted]').trim() || 'not ready'
    await closeAttempt(deps, attempt)
  }
  throw startError(
    `codex app-server did not become ready after ${START_ATTEMPTS} attempts: ${lastFailure}`,
  )
}
