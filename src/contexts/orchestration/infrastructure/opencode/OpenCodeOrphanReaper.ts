import { execFile } from 'node:child_process'
import type { AgentLink } from '../../domain/agentLink'
import { OPEN_CODE_TERM_GRACE_MS } from './OpenCodeServeProcess'

const POLL_MS = 100

export interface OpenCodeOrphanReaperDeps {
  readCommandLine: (pid: number) => Promise<string | null>
  killGroup: (pid: number, signal: NodeJS.Signals) => void
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
}

export const realOpenCodeOrphanReaperDeps: OpenCodeOrphanReaperDeps = {
  readCommandLine: pid =>
    process.platform === 'win32'
      ? Promise.resolve(null)
      : new Promise(resolve => {
          execFile('ps', ['-ww', '-o', 'args=', '-p', String(pid)], (error, stdout) =>
            resolve(error || stdout.trim() === '' ? null : stdout.trim()),
          )
        }),
  killGroup: (pid, signal) => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, signal)
    } catch {
      // The group is already gone.
    }
  },
  isAlive: pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

const executableName = (token: string): string => token.split(/[\\/]/).at(-1) ?? ''

/**
 * The password travels in the environment, so the line has no hash to check. The shape is the
 * identity: `opencode serve` on loopback. An ambiguous line is never a match, because the residual
 * risk of leaving an orphan is smaller than signalling a process that is not ours.
 */
export function matchesOpenCodeServe(commandLine: string): boolean {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 3 || executableName(tokens[0]) !== 'opencode' || tokens[1] !== 'serve') {
    return false
  }
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--hostname') {
      return tokens[index + 1] === '127.0.0.1'
    }
    if (token.startsWith('--hostname=')) {
      return token.slice('--hostname='.length) === '127.0.0.1'
    }
  }
  return false
}

async function reapOne(deps: OpenCodeOrphanReaperDeps, pid: number): Promise<void> {
  if (pid <= 1) {
    return
  }
  const commandLine = await deps.readCommandLine(pid)
  if (!commandLine || !matchesOpenCodeServe(commandLine)) {
    return
  }
  deps.killGroup(pid, 'SIGTERM')
  const deadline = OPEN_CODE_TERM_GRACE_MS / POLL_MS
  for (let waited = 0; waited < deadline; waited += 1) {
    if (!deps.isAlive(pid)) {
      return
    }
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by design.
    await deps.sleep(POLL_MS)
  }
  if (deps.isAlive(pid)) {
    deps.killGroup(pid, 'SIGKILL')
  }
}

/** Implements `reapOrphanServices` for opencode: pid plus a loopback `opencode serve` line. */
export function createOpenCodeOrphanReaper(
  deps: OpenCodeOrphanReaperDeps = realOpenCodeOrphanReaperDeps,
): (links: readonly AgentLink[]) => Promise<void> {
  return async links => {
    await Promise.all(
      links.map(async link => {
        if (link.servicePid === null) {
          return
        }
        await reapOne(deps, link.servicePid).catch(() => undefined)
      }),
    )
  }
}
