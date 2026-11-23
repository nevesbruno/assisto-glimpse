import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { EXECUTOR_REMOTE_TOKEN_ENV } from './CodexRemoteTuiCommand'

const LSOF_TIMEOUT_MS = 2_000
const PS_TIMEOUT_MS = 2_000
const SHA256_HEX = /^[a-f0-9]{64}$/u
const LOOPBACK_REMOTE_URL = /^ws:\/\/127\.0\.0\.1:\d+$/u

export interface CodexWriterLockOwner {
  readonly pid: number
  readonly commandLine: string
}

function isNoOpenFileResult(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 1
  )
}

/** Lock file of a thread under `CODEX_HOME`; null for an id that never names a path segment. */
export function resolveCodexThreadWriterLockPath(
  resumeSessionId: string,
  codexHome: string | undefined,
): string | null {
  const normalizedSessionId = resumeSessionId.trim()
  if (
    normalizedSessionId.length === 0 ||
    normalizedSessionId.includes('/') ||
    normalizedSessionId.includes('\\') ||
    normalizedSessionId === '.' ||
    normalizedSessionId === '..'
  ) {
    return null
  }
  // Codex itself defaults to ~/.codex when CODEX_HOME is absent; the lock lives there too.
  const home = codexHome?.trim() || join(homedir(), '.codex')
  return resolve(home, 'thread-writer-locks', `${normalizedSessionId}.lock`)
}

/** The command line of a Glimpse-managed app-server, never a TUI or a foreign process. */
export function isCodexAppServerCommandLine(commandLine: string): boolean {
  return (
    /(?:^|\s)app-server(?:\s|$)/u.test(commandLine) &&
    /(?:^|\s)--ws-token-sha256(?:\s|$)/u.test(commandLine)
  )
}

export function codexAppServerTokenSha256(commandLine: string): string | null {
  const match = /(?:^|\s)--ws-token-sha256\s+(\S+)/u.exec(commandLine)
  const token = match?.[1] ?? null
  return token !== null && SHA256_HEX.test(token) ? token : null
}

/** Exact `-c projects={...}` argument the app-server of this cwd carries, never a path prefix. */
function projectTrustArgument(cwd: string): string {
  const tomlString = JSON.stringify(cwd).replaceAll('\u007f', '\\u007f')
  return `-c projects={${tomlString}={trust_level="trusted"}}`
}

/**
 * A holder is ours only when it is an app-server carrying the exact hash the link recorded and
 * the project argument of this cwd, or the remote TUI this app launched for the very same thread
 * and cwd. Without a trustworthy hash it is a stranger: the caller waits and fails closed instead
 * of killing by shape. A pid another active link owns is never touched.
 */
export function isOwnedCodexWriterLockHolder(input: {
  readonly pid: number
  readonly commandLine: string
  readonly expectedTokenSha256?: string | null
  readonly cwd?: string | null
  readonly protectedPids?: readonly number[]
  /** Thread being resumed; the remote TUI carries it in its `resume <threadId>` argument. */
  readonly threadId?: string | null
}): boolean {
  if (input.pid <= 1 || (input.protectedPids ?? []).includes(input.pid)) {
    return false
  }
  const cwd = input.cwd?.trim() ?? ''
  if (cwd.length === 0) {
    return false
  }
  if (isOwnedCodexAppServerHolder(input)) {
    return true
  }
  const threadId = input.threadId?.trim() ?? ''
  return (
    threadId.length > 0 &&
    isCodexRemoteTuiCommandLine({ commandLine: input.commandLine, threadId, cwd })
  )
}

/**
 * A Glimpse app-server of this project: token hash recorded by the link and exact project
 * argument. A null hash keeps the holder alive, as a stranger.
 */
function isOwnedCodexAppServerHolder(input: {
  readonly commandLine: string
  readonly expectedTokenSha256?: string | null
  readonly cwd?: string | null
}): boolean {
  if (!input.expectedTokenSha256 || !isCodexAppServerCommandLine(input.commandLine)) {
    return false
  }
  const token = codexAppServerTokenSha256(input.commandLine)
  if (token === null || token !== input.expectedTokenSha256) {
    return false
  }
  const cwd = input.cwd?.trim() ?? ''
  return cwd.length > 0 && input.commandLine.includes(projectTrustArgument(cwd))
}

/**
 * The remote TUI launched by this app for a thread. Identity is the exact marker, never a broad
 * pattern: one executable token, then `resume <threadId> --remote <loopback url>
 * --remote-auth-token-env OPENCOVE_EXECUTOR_REMOTE_TOKEN -C <cwd>` ending the command line.
 * Another thread, another cwd, a foreign remote client, a non-loopback URL, extra arguments or a
 * path with whitespace stay strangers and are never killed.
 */
export function isCodexRemoteTuiCommandLine(input: {
  readonly commandLine: string
  readonly threadId: string
  readonly cwd: string
}): boolean {
  const threadId = input.threadId.trim()
  const cwd = input.cwd.trim()
  if (threadId.length === 0 || cwd.length === 0 || /\s/u.test(threadId)) {
    return false
  }
  const marker = ` resume ${threadId} --remote `
  const markerIndex = input.commandLine.indexOf(marker)
  if (markerIndex <= 0) {
    return false
  }
  const executable = input.commandLine.slice(0, markerIndex)
  if (/\s/u.test(executable)) {
    return false
  }
  const rest = input.commandLine.slice(markerIndex + marker.length)
  const urlEnd = rest.indexOf(' ')
  if (urlEnd <= 0 || !LOOPBACK_REMOTE_URL.test(rest.slice(0, urlEnd))) {
    return false
  }
  return rest.slice(urlEnd + 1) === `--remote-auth-token-env ${EXECUTOR_REMOTE_TOKEN_ENV} -C ${cwd}`
}

function parsePids(stdout: string): number[] {
  const pids = new Set<number>()
  for (const piece of stdout.split(/\s+/u)) {
    const pid = Number(piece)
    if (Number.isInteger(pid) && pid > 1) {
      pids.add(pid)
    }
  }
  return [...pids].sort((a, b) => a - b)
}

/** Pids holding the lock; null when the probe itself failed and no kill decision is safe. */
export function listCodexWriterLockOwnerPids(lockPath: string): Promise<readonly number[] | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return Promise.resolve(null)
  }
  if (!existsSync(lockPath)) {
    return Promise.resolve([])
  }
  return new Promise(resolvePromise => {
    execFile(
      'lsof',
      ['-t', '--', lockPath],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolvePromise(isNoOpenFileResult(error) ? [] : null)
          return
        }
        resolvePromise(parsePids(stdout))
      },
    )
  })
}

export function readProcessCommandLine(pid: number): Promise<string | null> {
  if (process.platform === 'win32') {
    return Promise.resolve(null)
  }
  return new Promise(resolvePromise => {
    execFile(
      'ps',
      ['-ww', '-o', 'args=', '-p', String(pid)],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => resolvePromise(error || stdout.trim() === '' ? null : stdout.trim()),
    )
  })
}

export function endProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1) {
    return
  }
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    // The group is already gone.
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
