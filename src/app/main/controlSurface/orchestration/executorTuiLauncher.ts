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

export interface ExecutorTuiLauncherDeps {
  readonly ptyRuntime: Pick<ControlSurfacePtyRuntime, 'spawnSession' | 'kill'>
  readonly resolveCodexExecutable: () => string
  readonly liveSessionOf: (nodeId: string) => string | null
  /** Attaches the new PTY to the executor node (composition owns the node state). */
  readonly bindSession: (nodeId: string, sessionId: string) => Promise<void>
}

/** Runs outside `canvasSpawnIdentity`, so the PTY never gets a window grant (A5). */
export function createExecutorTuiLauncher(deps: ExecutorTuiLauncherDeps): ExecutorTuiLauncher {
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
    relaunch: async input => {
      const live = deps.liveSessionOf(input.executorNodeId)
      if (live) {
        deps.ptyRuntime.kill(live)
      }
      await spawnTui(input)
    },
  }
}
