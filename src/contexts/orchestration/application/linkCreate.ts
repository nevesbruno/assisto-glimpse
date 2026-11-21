import {
  createExecutorLink,
  OrchestrationError,
  type AgentLinkRuntimeMode,
} from '../domain/agentLink'
import type { OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import { closeExecutorLink } from './linkLifecycle'
import { activateLinkedExecutor } from './linkBootstrap'
import type { OrchestrationContext } from './OrchestrationService'
import { translateRuntimeError } from './runtimeErrors'

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
      executorSessionRef: executor.sessionRef ?? null,
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
      await activateLinkedExecutor(ctx, link)
    } catch (error) {
      await closeExecutorLink(ctx, link, 'spawn_failed', true)
      throw translateRuntimeError(error)
    }
  })
  return { linkId: link.id, runtimeMode: link.runtimeMode }
}
