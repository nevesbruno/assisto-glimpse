import type {
  ExecutorTuiLauncher,
  LaunchExecutorTuiInput,
} from '../../../../contexts/orchestration/application/ports'
import {
  EXECUTOR_REMOTE_TOKEN_ENV,
  buildCodexRemoteTuiCommand,
} from '../../../../contexts/orchestration/infrastructure/codex/CodexRemoteTuiCommand'
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from '../handlers/sessionPrepareOrReviveGeometry'
import type { ControlSurfacePtyRuntime } from '../handlers/sessionPtyRuntime'
import { canvasSpawnIdentity } from '../sessionSpawnIdentityContext'

/** Gives `link.create` time to return and the sync to carry the new sessionId to the renderer. */
export const RELAUNCH_KILL_DELAY_MS = 3_000

export type DisposableExecutorTuiLauncher = ExecutorTuiLauncher & {
  /** Kills every PTY whose kill is still pending. */
  dispose: () => void
}

export interface ExecutorTuiLauncherDeps {
  readonly ptyRuntime: Pick<ControlSurfacePtyRuntime, 'spawnSession' | 'kill'>
  readonly resolveCodexExecutable: () => string
  readonly liveSessionOf: (nodeId: string) => string | null
  /** Attaches the new PTY to the executor node (composition owns the node state). */
  readonly bindSession: (nodeId: string, sessionId: string) => Promise<void>
  readonly killDelayMs?: number
}

/** Runs outside `canvasSpawnIdentity`, so the PTY never gets a window grant (A5). */
export function createExecutorTuiLauncher(
  deps: ExecutorTuiLauncherDeps,
): DisposableExecutorTuiLauncher {
  const pendingKills = new Map<string, { sessionId: string; timer: NodeJS.Timeout }>()

  const flushPendingKill = (nodeId: string): void => {
    const pending = pendingKills.get(nodeId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    pendingKills.delete(nodeId)
    deps.ptyRuntime.kill(pending.sessionId)
  }

  const killLater = (nodeId: string, sessionId: string): void => {
    const timer = setTimeout(
      () => flushPendingKill(nodeId),
      deps.killDelayMs ?? RELAUNCH_KILL_DELAY_MS,
    )
    timer.unref()
    pendingKills.set(nodeId, { sessionId, timer })
  }

  const spawnTui = async (input: LaunchExecutorTuiInput): Promise<void> => {
    const { command, args } = buildCodexRemoteTuiCommand({
      executablePath: deps.resolveCodexExecutable(),
      threadId: input.attach.sessionRef,
      url: input.attach.url,
      cwd: input.attach.cwd,
    })
    const { sessionId } = await canvasSpawnIdentity.exit(() =>
      deps.ptyRuntime.spawnSession({
        cwd: input.attach.cwd,
        cols: DEFAULT_PTY_COLS,
        rows: DEFAULT_PTY_ROWS,
        command,
        args,
        injectedEnv: { [EXECUTOR_REMOTE_TOKEN_ENV]: input.attach.tokenEnv.value },
      }),
    )
    await deps.bindSession(input.executorNodeId, sessionId)
  }

  return {
    launch: spawnTui,
    /**
     * The new PTY is bound first and the old one dies later, so the renderer already knows the
     * new sessionId when the old exit arrives and its guard ignores it.
     */
    relaunch: async input => {
      const nodeId = input.executorNodeId
      const previous = deps.liveSessionOf(nodeId)
      await spawnTui(input)
      flushPendingKill(nodeId)
      if (previous) {
        killLater(nodeId, previous)
      }
    },
    retire: nodeId => {
      flushPendingKill(nodeId)
      const live = deps.liveSessionOf(nodeId)
      if (live) {
        deps.ptyRuntime.kill(live)
      }
    },
    dispose: () => {
      for (const nodeId of [...pendingKills.keys()]) {
        flushPendingKill(nodeId)
      }
    },
  }
}
