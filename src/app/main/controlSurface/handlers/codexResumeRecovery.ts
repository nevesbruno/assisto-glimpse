/* oxlint-disable no-await-in-loop -- lock probes and termination polling are sequential by design */
import { getAppErrorDebugMessage } from '../../../../shared/errors/appError'
import {
  endProcessGroup,
  isOwnedCodexWriterLockHolder,
  isProcessAlive,
  listCodexWriterLockOwnerPids,
  readProcessCommandLine,
  resolveCodexThreadWriterLockPath,
  type CodexWriterLockOwner,
} from '../../../../contexts/orchestration/infrastructure/codex/CodexWriterLock'

const DEFAULT_WRITER_LOCK_WAIT_MS = 1_500
const MAX_WRITER_LOCK_WAIT_MS = 5_000
const DEFAULT_WRITER_LOCK_POLL_MS = 100
const END_GRACE_MS = 3_000
const END_POLL_MS = 100
const ACTIVE_WRITER_PATTERN = /(?:-32600\b|already has an active writer)/iu

export type { CodexWriterLockOwner }

export type CodexWriterLockProbeResult = 'available' | 'occupied' | 'unknown'
export type CodexWriterLockWaitResult = CodexWriterLockProbeResult | 'timed_out'

type Sleep = (delayMs: number) => Promise<void>

function delay(delayMs: number): Promise<void> {
  return new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, Math.max(0, delayMs))
    timer.unref()
  })
}

function normalizeBoundedInteger(
  value: string | number | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }
  return Math.min(maximum, Math.floor(parsed))
}

export function resolveCodexWriterLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return normalizeBoundedInteger(
    env['OPENCOVE_CODEX_WRITER_LOCK_WAIT_MS'],
    DEFAULT_WRITER_LOCK_WAIT_MS,
    MAX_WRITER_LOCK_WAIT_MS,
  )
}

export async function probeCodexWriterLock(options: {
  resumeSessionId: string
  codexHome?: string
  platform?: NodeJS.Platform
}): Promise<CodexWriterLockProbeResult> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    return 'unknown'
  }

  const lockPath = resolveCodexThreadWriterLockPath(
    options.resumeSessionId,
    options.codexHome ?? process.env['CODEX_HOME'],
  )
  if (!lockPath) {
    return 'available'
  }

  const ownerPids = await listCodexWriterLockOwnerPids(lockPath)
  if (ownerPids === null) {
    return 'unknown'
  }
  return ownerPids.length > 0 ? 'occupied' : 'available'
}

export async function waitForCodexWriterLockRelease(options: {
  resumeSessionId: string
  maxWaitMs?: number
  pollIntervalMs?: number
  probe?: (resumeSessionId: string) => Promise<CodexWriterLockProbeResult>
  sleep?: Sleep
  now?: () => number
}): Promise<CodexWriterLockWaitResult> {
  const maxWaitMs = normalizeBoundedInteger(
    options.maxWaitMs,
    resolveCodexWriterLockWaitMs(),
    MAX_WRITER_LOCK_WAIT_MS,
  )
  const pollIntervalMs = Math.max(
    1,
    normalizeBoundedInteger(
      options.pollIntervalMs,
      DEFAULT_WRITER_LOCK_POLL_MS,
      MAX_WRITER_LOCK_WAIT_MS,
    ),
  )
  const probe =
    options.probe ??
    (async (resumeSessionId: string) => await probeCodexWriterLock({ resumeSessionId }))
  const sleep = options.sleep ?? delay
  const now = options.now ?? Date.now
  const deadlineMs = now() + maxWaitMs

  const poll = async (): Promise<CodexWriterLockWaitResult> => {
    const observation = await probe(options.resumeSessionId)
    if (observation !== 'occupied') {
      return observation
    }

    const remainingMs = deadlineMs - now()
    if (remainingMs <= 0) {
      return 'timed_out'
    }

    await sleep(Math.min(pollIntervalMs, remainingMs))
    return await poll()
  }

  return await poll()
}

export interface CodexWriterLockRecoveryDeps {
  readonly listOwnerPids: (lockPath: string) => Promise<readonly number[] | null>
  readonly readCommandLine: (pid: number) => Promise<string | null>
  readonly killGroup: (pid: number, signal: NodeJS.Signals) => void
  readonly isAlive: (pid: number) => boolean
  readonly sleep: Sleep
}

export const realCodexWriterLockRecoveryDeps: CodexWriterLockRecoveryDeps = {
  listOwnerPids: listCodexWriterLockOwnerPids,
  readCommandLine: readProcessCommandLine,
  killGroup: endProcessGroup,
  isAlive: isProcessAlive,
  sleep: delay,
}

export interface RecoverCodexWriterLockInput {
  readonly resumeSessionId: string
  readonly codexHome?: string
  readonly cwd: string
  /** Hash recorded by the link of the service that owned the thread before the crash. */
  readonly expectedTokenSha256?: string | null
  /** Services of other active links: holding another thread never makes them a kill target. */
  readonly protectedPids?: readonly number[]
  readonly waitMs?: number
  readonly pollIntervalMs?: number
}

export type CodexWriterLockRecoveryResult =
  | { readonly outcome: 'released'; readonly killedPids: readonly number[] }
  | {
      readonly outcome: 'held'
      readonly killedPids: readonly number[]
      readonly owners: readonly CodexWriterLockOwner[]
    }
  | { readonly outcome: 'unknown'; readonly owners: readonly CodexWriterLockOwner[] }

interface ObservedOwner {
  readonly pid: number
  readonly commandLine: string | null
}

async function observeOwners(
  lockPath: string,
  deps: CodexWriterLockRecoveryDeps,
): Promise<ObservedOwner[] | null> {
  const pids = await deps.listOwnerPids(lockPath)
  if (pids === null) {
    return null
  }
  return await Promise.all(
    pids.map(async pid => ({ pid, commandLine: await deps.readCommandLine(pid) })),
  )
}

function knownOwners(owners: readonly ObservedOwner[]): CodexWriterLockOwner[] {
  return owners.flatMap(owner =>
    owner.commandLine === null ? [] : [{ pid: owner.pid, commandLine: owner.commandLine }],
  )
}

async function endOwnedGroup(pid: number, deps: CodexWriterLockRecoveryDeps): Promise<void> {
  deps.killGroup(pid, 'SIGTERM')
  const deadline = Date.now() + END_GRACE_MS
  while (Date.now() < deadline) {
    if (!deps.isAlive(pid)) {
      return
    }
    await deps.sleep(END_POLL_MS)
  }
  if (deps.isAlive(pid)) {
    deps.killGroup(pid, 'SIGKILL')
  }
}

/**
 * Ends the lock holder only when its command line proves it is a Glimpse app-server of this
 * project or the remote TUI this app launched for the same thread and cwd; anything else is left
 * alive and reported. Never falls back to a pattern kill.
 */
export async function recoverCodexWriterLock(
  input: RecoverCodexWriterLockInput,
  overrides: Partial<CodexWriterLockRecoveryDeps> = {},
): Promise<CodexWriterLockRecoveryResult> {
  const deps = { ...realCodexWriterLockRecoveryDeps, ...overrides }
  const lockPath = resolveCodexThreadWriterLockPath(
    input.resumeSessionId,
    input.codexHome ?? process.env['CODEX_HOME'],
  )
  if (!lockPath) {
    return { outcome: 'unknown', owners: [] }
  }

  let observed = await observeOwners(lockPath, deps)
  if (observed === null) {
    return { outcome: 'unknown', owners: [] }
  }

  const killedPids: number[] = []
  const matching = observed.filter(
    owner =>
      owner.commandLine !== null &&
      isOwnedCodexWriterLockHolder({
        pid: owner.pid,
        commandLine: owner.commandLine,
        expectedTokenSha256: input.expectedTokenSha256,
        cwd: input.cwd,
        protectedPids: input.protectedPids,
        threadId: input.resumeSessionId,
      }),
  )
  for (const owner of matching) {
    killedPids.push(owner.pid)
    await endOwnedGroup(owner.pid, deps)
  }

  const waitMs = normalizeBoundedInteger(
    input.waitMs,
    resolveCodexWriterLockWaitMs(),
    MAX_WRITER_LOCK_WAIT_MS,
  )
  const pollIntervalMs = Math.max(
    1,
    normalizeBoundedInteger(
      input.pollIntervalMs,
      DEFAULT_WRITER_LOCK_POLL_MS,
      MAX_WRITER_LOCK_WAIT_MS,
    ),
  )
  const deadline = Date.now() + waitMs
  while (true) {
    observed = await observeOwners(lockPath, deps)
    if (observed === null) {
      return { outcome: 'unknown', owners: [] }
    }
    if (observed.length === 0) {
      return { outcome: 'released', killedPids }
    }
    if (Date.now() >= deadline) {
      return { outcome: 'held', killedPids, owners: knownOwners(observed) }
    }
    await deps.sleep(pollIntervalMs)
  }
}

function describeError(error: unknown): string {
  const debugMessage = getAppErrorDebugMessage(
    error instanceof Error || typeof error === 'string' ? error : null,
  )
  if (debugMessage) {
    return debugMessage
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function isCodexActiveWriterError(error: unknown): boolean {
  return ACTIVE_WRITER_PATTERN.test(describeError(error))
}

export class CodexWriterLockRecoveryExhaustedError extends Error {
  public readonly cause: unknown
  public readonly owners: readonly CodexWriterLockOwner[]

  public constructor(cause: unknown, owners: readonly CodexWriterLockOwner[] = []) {
    const detail = owners.length === 0 ? '' : ` (lock owners: ${owners.map(o => o.pid).join(',')})`
    super((describeError(cause) || 'Codex writer lock remained occupied') + detail)
    this.name = 'CodexWriterLockRecoveryExhaustedError'
    this.cause = cause
    this.owners = owners
  }
}

export async function runCodexResumeWithRetry<TResult>(options: {
  launch: () => Promise<TResult>
  maxAttempts: number
  backoffMs: readonly number[]
  sleep?: Sleep
}): Promise<TResult> {
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(options.maxAttempts)))
  const sleep = options.sleep ?? delay

  const runAttempt = async (attempt: number): Promise<TResult> => {
    try {
      return await options.launch()
    } catch (error) {
      if (!isCodexActiveWriterError(error)) {
        throw error
      }
      if (attempt >= maxAttempts) {
        throw new CodexWriterLockRecoveryExhaustedError(error)
      }

      const configuredDelay = options.backoffMs[attempt - 1] ?? 0
      await sleep(Math.max(0, Math.min(MAX_WRITER_LOCK_WAIT_MS, configuredDelay)))
      return await runAttempt(attempt + 1)
    }
  }

  return await runAttempt(1)
}
