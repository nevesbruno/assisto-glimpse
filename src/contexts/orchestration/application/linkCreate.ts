import {
  createExecutorLink,
  OrchestrationError,
  type AgentLinkRuntimeMode,
} from '../domain/agentLink'
import type { OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import { attachTui } from './executorTuiRelaunch'
import { closeExecutorLink } from './linkLifecycle'
import type { OrchestrationContext } from './OrchestrationService'
import { translateRuntimeError } from './runtimeErrors'
import { restartLinkedService } from './spawnExecutor'

export interface CreateLinkInput {
  readonly orchestratorNodeId: string
  readonly executorNodeId: string
}

/** The user links two nodes already on the canvas; the service starts and the TUI moves onto it. */
export async function createLink(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  input: CreateLinkInput,
): Promise<{ readonly linkId: string; readonly runtimeMode: AgentLinkRuntimeMode }> {
  await ctx.authorize(principal, 'orch.link.create', null)
  const { nodes, links, ids, clock } = ctx.deps
  const [orchestrator, executor] = await Promise.all([
    nodes.findNode(input.orchestratorNodeId),
    nodes.findNode(input.executorNodeId),
  ])
  if (!orchestrator || !executor || orchestrator.projectId !== executor.projectId) {
    throw new OrchestrationError('orch.link_invalid', 'node not found')
  }
  const link = {
    ...createExecutorLink({
      id: ids.uuid(),
      spaceId: executor.spaceId,
      orchestrator,
      executor,
      spawnRequestId: null,
      existingLinks: await links.listActive(),
      now: clock.now(),
    }),
    origin: 'canvas_manual',
  } as const
  const inserted = await links.insert(link)
  if (!inserted.ok) {
    throw new OrchestrationError('orch.link_invalid', inserted.reason)
  }
  await ctx.runExclusive(link.executorNodeId, async () => {
    try {
      await restartLinkedService(ctx, link)
      await attachTui(ctx, link.executorNodeId, 'relaunch')
    } catch (error) {
      await closeExecutorLink(ctx, link, 'spawn_failed', true)
      throw translateRuntimeError(error)
    }
    ctx.wake(link.executorNodeId)
  })
  return { linkId: link.id, runtimeMode: link.runtimeMode }
}
