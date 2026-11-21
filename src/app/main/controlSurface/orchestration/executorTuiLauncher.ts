import type {
  ExecutorTuiLauncher,
  LaunchExecutorTuiInput,
} from '../../../../contexts/orchestration/application/ports'
import type { ExecutorRuntimeProvider } from '../../../../contexts/orchestration/application/ports/executorRuntime'
import { buildCodexRemoteTuiCommand } from '../../../../contexts/orchestration/infrastructure/codex/CodexRemoteTuiCommand'
import {
  OPEN_CODE_REMOTE_PASSWORD_ENV,
  buildOpenCodeRemoteTuiCommand,
} from '../../../../contexts/orchestration/infrastructure/opencode/OpenCodeRemoteTuiCommand'
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
  /** Resolved before the launch: the codex executable, the historical entry point. */
  readonly resolveCodexExecutable: () => string
  /** Resolved per provider; without it an opencode TUI cannot be launched. */
  readonly resolveExecutable?: (provider: ExecutorRuntimeProvider) => string
  readonly liveSessionOf: (nodeId: string) => string | null
  /** Attaches the new PTY to the executor node (composition owns the node state). */
  readonly bindSession: (
    nodeId: string,
    sessionId: string,
    provider: ExecutorRuntimeProvider,
  ) => Promise<void>
  readonly killDelayMs?: number
}

/** The attach token names the provider: each adapter injects its own secret variable. */
export function providerOfAttach(
  attach: LaunchExecutorTuiInput['attach'],
): ExecutorRuntimeProvider {
  return attach.tokenEnv.name === OPEN_CODE_REMOTE_PASSWORD_ENV ? 'opencode' : 'codex'
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

  const commandOf = (
    provider: ExecutorRuntimeProvider,
    input: LaunchExecutorTuiInput,
  ): { command: string; args: string[] } => {
    const executablePath =
      deps.resolveExecutable?.(provider) ??
      (provider === 'codex'
        ? deps.resolveCodexExecutable()
        : (() => {
            throw new Error('The opencode executable was not resolved before the TUI launch.')
          })())
    if (provider === 'opencode') {
      return buildOpenCodeRemoteTuiCommand({
        executablePath,
        sessionId: input.attach.sessionRef,
        url: input.attach.url,
        cwd: input.attach.cwd,
      })
    }
    return buildCodexRemoteTuiCommand({
      executablePath,
      threadId: input.attach.sessionRef,
      url: input.attach.url,
      cwd: input.attach.cwd,
    })
  }

  const spawnTui = async (input: LaunchExecutorTuiInput): Promise<void> => {
    const provider = providerOfAttach(input.attach)
    const { command, args } = commandOf(provider, input)
    const { sessionId } = await canvasSpawnIdentity.exit(() =>
      deps.ptyRuntime.spawnSession({
        cwd: input.attach.cwd,
        cols: DEFAULT_PTY_COLS,
        rows: DEFAULT_PTY_ROWS,
        command,
        args,
        injectedEnv: { [input.attach.tokenEnv.name]: input.attach.tokenEnv.value },
      }),
    )
    await deps.bindSession(input.executorNodeId, sessionId, provider)
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
