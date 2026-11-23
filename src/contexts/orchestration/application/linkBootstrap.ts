import type { AgentLink } from '../domain/agentLink'
import { attachTui } from './executorTuiRelaunch'
import type { OrchestrationContext } from './OrchestrationService'
import { restartLinkedService } from './spawnExecutor'

/**
 * Puts an already active executor link to work: the service starts from the link's session ref,
 * the TUI moves onto it and the pump wakes. F3-02b1 and F3-02b2 reuse this step.
 */
export async function activateLinkedExecutor(
  ctx: OrchestrationContext,
  link: AgentLink,
  tuiMode: 'launch' | 'relaunch' = 'relaunch',
): Promise<void> {
  await restartLinkedService(ctx, link)
  await attachTui(ctx, link.executorNodeId, tuiMode)
  ctx.wake(link.executorNodeId)
}
