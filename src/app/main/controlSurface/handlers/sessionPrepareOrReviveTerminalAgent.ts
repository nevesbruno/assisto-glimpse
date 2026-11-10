import {
  buildTerminalAgentReentryCommand,
  enterTerminalAgentInFreshPty,
} from '../../../../contexts/agent/application/terminalAgentPtyReexec'
import {
  isResumeSessionBindingVerified,
  normalizeResumeSessionBinding,
} from '../../../../contexts/agent/domain/agentResumeBinding'
import type { ControlSurfacePtyRuntime } from './sessionPtyRuntime'
import type { NormalizedPersistedNode } from './sessionPrepareOrReviveShared'

export async function reenterTerminalAgent(options: {
  node: NormalizedPersistedNode
  sessionId: string
  ptyRuntime: Pick<ControlSurfacePtyRuntime, 'waitForShellReady' | 'write'>
  /** Resolves true when the node is a linked executor and the orchestration took over the revive. */
  reviveExecutor?: (input: { nodeId: string; sessionId: string }) => Promise<boolean>
}): Promise<void> {
  if (await options.reviveExecutor?.({ nodeId: options.node.id, sessionId: options.sessionId })) {
    return
  }
  const binding = normalizeResumeSessionBinding(options.node.agent)
  if (!binding || !isResumeSessionBindingVerified(binding)) {
    return
  }

  await enterTerminalAgentInFreshPty({
    sessionId: options.sessionId,
    command: buildTerminalAgentReentryCommand({
      provider: binding.provider,
      resumeSessionId: binding.resumeSessionId,
    }),
    waitForShellReady: async () => {
      await options.ptyRuntime.waitForShellReady?.(options.sessionId)
    },
    write: async input => {
      await Promise.resolve(options.ptyRuntime.write(input.sessionId, input.data))
    },
  })
}
