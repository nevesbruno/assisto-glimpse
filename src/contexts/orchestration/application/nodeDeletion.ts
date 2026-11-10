import type { AgentLink } from '../domain/agentLink'
import { closeExecutorLink } from './linkLifecycle'
import type { OrchestrationContext } from './OrchestrationService'
import { callRuntime } from './runtimeErrors'

/** What the reconciler needs from the host; both are optional so a bare service never closes. */
export interface NodeDeletionDeps {
  /** Ids of every node in the stored app state, or null when it cannot be told (no workspace). */
  readonly readLiveNodeIds?: () => Promise<ReadonlySet<string> | null>
  /** The Worker is stopping: nothing new may start. */
  readonly isStopped?: () => boolean
}

async function readLive(ctx: OrchestrationContext): Promise<ReadonlySet<string> | null> {
  try {
    const live = await ctx.deps.readLiveNodeIds?.()
    return live && live.size > 0 ? live : null
  } catch {
    return null
  }
}

async function closeDeleted(ctx: OrchestrationContext, link: AgentLink): Promise<void> {
  await ctx.runExclusive(link.executorNodeId, async () => {
    const { links, dispatches } = ctx.deps
    const current = await links.findActiveByExecutor(link.executorNodeId)
    if (current?.id !== link.id) {
      return
    }
    const runtime = ctx.slotOf(link.executorNodeId).runtime
    const open = await dispatches.findInFlightByExecutor(link.executorNodeId)
    if (runtime && open?.turnRef) {
      await callRuntime(() => runtime.interrupt(open.turnRef ?? undefined)).catch(() => undefined)
    }
    await closeExecutorLink(ctx, current, 'node_deleted', true)
  })
}

/**
 * Closes each active link whose executor or orchestrator node is not in the stored state (I-07).
 * The state is read from the store, never taken from a payload; an unreadable or empty state
 * closes nothing, and without a missing node nothing is written.
 */
export async function reconcileDeletedNodes(ctx: OrchestrationContext): Promise<void> {
  const live = await readLive(ctx)
  if (!live) {
    return
  }
  const gone = (await ctx.deps.links.listActive()).filter(
    link => !live.has(link.executorNodeId) || !live.has(link.orchestratorNodeId),
  )
  await Promise.all(
    gone.map(link => closeDeleted(ctx, link).catch(error => ctx.deps.onBackgroundError?.(error))),
  )
}
