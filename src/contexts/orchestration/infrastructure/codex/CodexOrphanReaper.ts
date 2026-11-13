import { execFile } from 'node:child_process'
import type { AgentLink } from '../../domain/agentLink'
import { TERM_GRACE_MS } from './CodexAppServerProcess'
import { listCodexWriterLockOwnerPids, resolveCodexThreadWriterLockPath } from './CodexWriterLock'

const POLL_MS = 100

export interface CodexOrphanReaperDeps {
  readCommandLine: (pid: number) => Promise<string | null>
  killGroup: (pid: number, signal: NodeJS.Signals) => void
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  /** Pids holding the thread writer lock, even when the recorded service pid is stale. */
  listLockOwnerPids?: (
    resumeSessionId: string,
    codexHome: string | undefined,
  ) => Promise<readonly number[] | null>
}

export const realCodexOrphanReaperDeps: CodexOrphanReaperDeps = {
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
  listLockOwnerPids: async (resumeSessionId, codexHome) => {
    const lockPath = resolveCodexThreadWriterLockPath(resumeSessionId, codexHome)
    return lockPath ? await listCodexWriterLockOwnerPids(lockPath) : []
  },
}

async function reapOne(
  deps: CodexOrphanReaperDeps,
  pid: number,
  tokenSha256: string,
): Promise<void> {
  if (pid <= 1) {
    return
  }
  const commandLine = await deps.readCommandLine(pid)
  if (!commandLine?.includes(`--ws-token-sha256 ${tokenSha256}`)) {
    return
  }
  deps.killGroup(pid, 'SIGTERM')
  const deadline = TERM_GRACE_MS / POLL_MS
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

/** Implements `reapOrphanServices`: ends only a process whose pid and token hash both match. */
export function createCodexOrphanReaper(
  deps: CodexOrphanReaperDeps = realCodexOrphanReaperDeps,
): (links: readonly AgentLink[]) => Promise<void> {
  const codexHome = process.env['CODEX_HOME']
  const candidatesOf = async (link: AgentLink): Promise<number[]> => {
    const candidates = new Set<number>()
    if (link.servicePid !== null && link.serviceTokenSha256 !== null) {
      candidates.add(link.servicePid)
    }
    if (link.executorSessionRef && link.serviceTokenSha256 && deps.listLockOwnerPids) {
      const owners = await deps
        .listLockOwnerPids(link.executorSessionRef, codexHome)
        .catch(() => [] as readonly number[])
      for (const pid of owners ?? []) {
        candidates.add(pid)
      }
    }
    return [...candidates]
  }
  return async links => {
    await Promise.all(
      links.map(async link => {
        if (link.serviceTokenSha256 === null) {
          return
        }
        const tokenSha256 = link.serviceTokenSha256
        const candidates = await candidatesOf(link).catch(() => [])
        await Promise.all(
          candidates.map(pid => reapOne(deps, pid, tokenSha256).catch(() => undefined)),
        )
      }),
    )
  }
}
