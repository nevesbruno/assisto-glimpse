import { OrchestrationError, type AgentLink, type AgentLinkCloseReason } from '../domain/agentLink'
import { visibleLinks, type OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import { closeExecutorLink } from './linkLifecycle'
import type { OrchestrationContext } from './OrchestrationService'
import type { AgentLinkRepository, ExecutorNodePort } from './ports'

export interface ExecutorTargetDeps {
  readonly links: Pick<AgentLinkRepository, 'listActive'>
  readonly nodes: Pick<ExecutorNodePort, 'findNode'>
}

/**
 * Resolves `orch close --to` to an active link: exact node id first, then the node title.
 * The candidate set is the caller's visible links, so a foreign title is indistinguishable
 * from a missing one. A title shared by two visible links is refused instead of guessed.
 */
export async function resolveExecutorTarget(
  deps: ExecutorTargetDeps,
  principal: OrchestrationPrincipal,
  target: string,
): Promise<AgentLink | null> {
  const links = visibleLinks(principal, await deps.links.listActive())
  const byId = links.find(link => link.executorNodeId === target)
  if (byId) {
    return byId
  }
  const nodes = await Promise.all(links.map(link => deps.nodes.findNode(link.executorNodeId)))
  const matches = links.filter((_, index) => nodes[index]?.title === target)
  if (matches.length > 1) {
    throw new OrchestrationError(
      'orch.link_invalid',
      `more than one linked executor is titled "${target}"; use the node id`,
    )
  }
  return matches[0] ?? null
}

export interface CloseExecutorInput {
  readonly to: string
  readonly force?: boolean
}

/** Authorizes the raw selector before revealing whether it matched, then closes under the slot. */
export async function closeExecutorTarget(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  input: CloseExecutorInput,
): Promise<void> {
  const link = await resolveExecutorTarget(ctx.deps, principal, input.to)
  await ctx.authorize(principal, 'orch.close', link?.executorNodeId ?? input.to)
  if (!link) {
    throw new OrchestrationError('orch.not_linked')
  }
  const reason: AgentLinkCloseReason = principal.kind === 'user' ? 'user' : 'orchestrator'
  await ctx.runExclusive(link.executorNodeId, async () => {
    const current = await ctx.deps.links.findActiveByExecutor(link.executorNodeId)
    if (!current || current.id !== link.id) {
      throw new OrchestrationError('orch.not_linked')
    }
    await closeExecutorLink(ctx, current, reason, input.force ?? false)
  })
}
