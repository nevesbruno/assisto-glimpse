import type { AgentLink } from '../domain/agentLink'
import { isFinalDispatchState, type Dispatch } from '../domain/dispatch'
import { evaluateDispatchAdmission, type DispatchAdmission } from '../domain/dispatchAdmission'
import { visibleLinks, type OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import type {
  OrchestrationDispatchView,
  OrchestrationStatusResult,
} from '../../../shared/contracts/dto/orchestration'
import { executorHealthOf } from './executorHealth'
import type { OrchestrationContext } from './OrchestrationService'

export function dispatchViewOf(dispatch: Dispatch): OrchestrationDispatchView {
  return {
    dispatchId: dispatch.id,
    state: dispatch.state,
    round: dispatch.round,
    reason: dispatch.reason,
    outcome: dispatch.outcome,
    createdAt: dispatch.createdAt,
    deadlineAt: dispatch.deadlineAt,
    finishedAt: dispatch.finishedAt,
  }
}

/** The single admission decision shared by `orch.dispatch` and `orch.status`. */
export async function currentAdmission(
  ctx: OrchestrationContext,
  link: AgentLink,
  open?: Dispatch | null,
): Promise<DispatchAdmission> {
  const openDispatch =
    open === undefined
      ? await ctx.deps.dispatches.findNonFinalByExecutor(link.executorNodeId)
      : open
  return evaluateDispatchAdmission({
    link,
    health: executorHealthOf(ctx.slotOf(link.executorNodeId).health),
    openDispatch,
  })
}

async function lastFinalOf(ctx: OrchestrationContext, link: AgentLink): Promise<Dispatch | null> {
  const finals = (await ctx.deps.dispatches.listByLink(link.id))
    .filter(dispatch => isFinalDispatchState(dispatch.state))
    .sort((a, b) => b.round - a.round || b.createdAt.localeCompare(a.createdAt))
  return finals[0] ?? null
}

async function pendingHookCount(ctx: OrchestrationContext, executorNodeId: string) {
  const { pendingHooks } = ctx.slotOf(executorNodeId)
  const approved = await ctx.deps.hookApprovals.findApproved(
    pendingHooks.map(({ key, currentHash }) => ({ key, currentHash })),
  )
  return pendingHooks.length - approved.length
}

async function statusLinkOf(ctx: OrchestrationContext, link: AgentLink) {
  const { dispatches, notices, nodes } = ctx.deps
  const slot = ctx.slotOf(link.executorNodeId)
  const open = await dispatches.findNonFinalByExecutor(link.executorNodeId)
  const last = await lastFinalOf(ctx, link)
  const node = await nodes.findNode(link.executorNodeId)
  return {
    linkId: link.id,
    executorNodeId: link.executorNodeId,
    title: node?.title ?? '',
    provider: link.provider,
    runtimeMode: link.runtimeMode,
    health: executorHealthOf(slot.health),
    roundsUsed: link.roundsUsed,
    roundsLimit: link.roundsLimit,
    admission: await currentAdmission(ctx, link, open),
    current: open ? dispatchViewOf(open) : null,
    last: last ? dispatchViewOf(last) : null,
    pendingApprovals: slot.pendingApprovals.size,
    pendingHooks: await pendingHookCount(ctx, link.executorNodeId),
    notices: {
      pending: (await notices.listPending(link.orchestratorNodeId)).length,
      uncertain: (await notices.listUncertain(link.orchestratorNodeId)).length,
    },
  }
}

export async function buildStatus(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  to: string | null,
): Promise<OrchestrationStatusResult> {
  const visible = visibleLinks(principal, await ctx.deps.links.listActive())
  const selected = to === null ? visible : visible.filter(link => link.executorNodeId === to)
  return {
    linksRevision: await ctx.deps.links.readLinksRevision(),
    links: await Promise.all(selected.map(link => statusLinkOf(ctx, link))),
  }
}
