/* eslint-disable no-await-in-loop -- start attempts and readiness polling are sequential by design. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import type { PortReserver } from '../../application/ports/hostPorts'
import type { ExecutorRuntimeError } from '../../application/ports/executorRuntime'
import type { ServiceExit } from '../process/ExecutorProcessSupervisor'
import { openCodeServeArgs, openCodeServeEnv } from './openCodeProcessEnv'

export const OPEN_CODE_START_ATTEMPTS = 3
export const OPEN_CODE_READINESS_TIMEOUT_MS = 10_000
export const OPEN_CODE_READINESS_POLL_MS = 100
export const OPEN_CODE_TERM_GRACE_MS = 3000
const STDERR_TAIL_CHARS = 2000

export interface OpenCodeServeChild {
  readonly pid?: number
  readonly stderr?: NodeJS.ReadableStream | null
  once: {
    (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
    (event: 'error', listener: (error: Error) => void): unknown
  }
}

/**
 * `ok` is the only compatible answer: the version and the capabilities come from the API, never
 * from the version string. `mismatch` is terminal for the attempt; `unauthorized` is a credential
 * failure of the Worker itself; `unreachable` means "not ready yet".
 */
export type OpenCodeInfoProbe =
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'mismatch'; readonly reason: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unreachable' }

export interface OpenCodeServeDeps {
  portReserver: PortReserver
  spawnChild: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) => OpenCodeServeChild
  probeInfo: (port: number, password: string) => Promise<OpenCodeInfoProbe>
  sleep: (ms: number) => Promise<void>
  now: () => number
  killGroup: (pid: number, signal: NodeJS.Signals) => void
  randomToken: () => string
}

export interface OpenCodeServeStartInput {
  readonly executablePath: string
  readonly cwd: string
  /** Child environment already filtered by `buildOpenCodeProcessEnv`; the password is added here. */
  readonly env: Record<string, string>
}

export interface OpenCodeServeProcess {
  readonly pid: number
  readonly port: number
  readonly url: string
  /** Only in memory: the environment of the child carries it, the command line never does. */
  readonly password: string
  /** SHA-256 hex of `password`, the same shape the link stores for any service. */
  readonly passwordSha256: string
  readonly exited: Promise<ServiceExit>
  close: () => Promise<void>
}

function startError(message: string): ExecutorRuntimeError {
  return Object.assign(new Error(message), { code: 'executor.start_failed' as const })
}

function mismatchError(message: string): ExecutorRuntimeError {
  return Object.assign(new Error(message), { code: 'executor.protocol_mismatch' as const })
}

const basicCredential = (password: string): string =>
  `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`

/** Decides compatibility by the API body: HTML, 404 or a missing field is a mismatch. */
export async function probeOpenCodeInfo(
  port: number,
  password: string,
  timeoutMs = 1000,
): Promise<OpenCodeInfoProbe> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/info`, {
      headers: { authorization: basicCredential(password) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { kind: 'unreachable' }
  }
  if (response.status === 401) {
    return { kind: 'unauthorized' }
  }
  if (response.status === 404) {
    return { kind: 'mismatch', reason: 'api_info_missing' }
  }
  if (!response.ok) {
    return { kind: 'unreachable' }
  }
  const text = await response.text().catch(() => null)
  if (text === null) {
    return { kind: 'unreachable' }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { kind: 'mismatch', reason: 'info_not_json' }
  }
  if (typeof body !== 'object' || body === null) {
    return { kind: 'mismatch', reason: 'info_not_object' }
  }
  const info = body as { version?: unknown; capabilities?: unknown }
  if (typeof info.version !== 'string' || info.version.trim() === '') {
    return { kind: 'mismatch', reason: 'info_version_missing' }
  }
  if (typeof info.capabilities !== 'object' || info.capabilities === null) {
    return { kind: 'mismatch', reason: 'info_capabilities_missing' }
  }
  return { kind: 'ok', version: info.version }
}

const realDeps = (portReserver: PortReserver): OpenCodeServeDeps => ({
  portReserver,
  spawnChild: (command, args, options) =>
    spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    }),
  probeInfo: (port, password) => probeOpenCodeInfo(port, password),
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
  child: OpenCodeServeChild
  pid: number
  exited: Promise<ServiceExit>
  isExited: () => boolean
  stderrTail: () => string
}

function spawnAttempt(
  deps: OpenCodeServeDeps,
  input: OpenCodeServeStartInput,
  port: number,
  password: string,
): Attempt {
  const child = deps.spawnChild(input.executablePath, openCodeServeArgs({ port }), {
    cwd: input.cwd,
    env: openCodeServeEnv(input.env, password),
  })
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

async function closeAttempt(deps: OpenCodeServeDeps, attempt: Attempt): Promise<void> {
  if (attempt.isExited() || attempt.pid < 0) {
    return
  }
  deps.killGroup(attempt.pid, 'SIGTERM')
  const outcome = await Promise.race([
    attempt.exited.then(() => 'exited' as const),
    deps.sleep(OPEN_CODE_TERM_GRACE_MS).then(() => 'timeout' as const),
  ])
  if (outcome === 'timeout') {
    deps.killGroup(attempt.pid, 'SIGKILL')
    await attempt.exited
  }
}

type WaitOutcome =
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'mismatch'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }

async function waitReady(
  deps: OpenCodeServeDeps,
  attempt: Attempt,
  port: number,
  password: string,
): Promise<WaitOutcome> {
  const deadline = deps.now() + OPEN_CODE_READINESS_TIMEOUT_MS
  while (deps.now() < deadline) {
    if (attempt.isExited()) {
      return { kind: 'failed', reason: attempt.stderrTail().trim() || 'process exited' }
    }
    const probe = await deps.probeInfo(port, password)
    if (probe.kind === 'ok') {
      return attempt.isExited() ? { kind: 'failed', reason: 'process exited' } : probe
    }
    if (probe.kind === 'mismatch') {
      return probe
    }
    if (probe.kind === 'unauthorized') {
      // The credential belongs to the Worker itself: a new port will not fix it.
      return { kind: 'failed', reason: 'the server rejected the credential of its own process' }
    }
    await deps.sleep(OPEN_CODE_READINESS_POLL_MS)
  }
  return { kind: 'failed', reason: attempt.stderrTail().trim() || 'not ready' }
}

/**
 * Starts `opencode serve` on a loopback port with a fresh Basic password and waits for `/api/info`
 * to prove the API. Up to 3 attempts on a new port; a protocol mismatch is terminal.
 */
export async function startOpenCodeServeProcess(
  input: OpenCodeServeStartInput,
  portReserver: PortReserver,
  overrides: Partial<OpenCodeServeDeps> = {},
): Promise<OpenCodeServeProcess> {
  const deps = { ...realDeps(portReserver), ...overrides }
  let lastFailure = 'unknown'
  for (let index = 0; index < OPEN_CODE_START_ATTEMPTS; index += 1) {
    const port = await deps.portReserver.reserveLoopbackPort()
    const password = deps.randomToken()
    const attempt = spawnAttempt(deps, input, port, password)
    const outcome = await waitReady(deps, attempt, port, password)
    if (outcome.kind === 'ok') {
      const passwordSha256 = createHash('sha256').update(password).digest('hex')
      const close = (): Promise<void> => closeAttempt(deps, attempt)
      return {
        pid: attempt.pid,
        port,
        url: `http://127.0.0.1:${port}`,
        password,
        passwordSha256,
        exited: attempt.exited,
        close,
      }
    }
    if (outcome.kind === 'mismatch') {
      await closeAttempt(deps, attempt)
      throw mismatchError(`unexpected /api/info: ${outcome.reason}`)
    }
    lastFailure = outcome.reason.replaceAll(password, '[redacted]')
    await closeAttempt(deps, attempt)
  }
  throw startError(
    `opencode serve did not become ready after ${OPEN_CODE_START_ATTEMPTS} attempts: ${lastFailure}`,
  )
}
