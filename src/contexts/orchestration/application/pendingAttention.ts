import { OrchestrationError } from '../domain/agentLink'
import { visibleLinks, type OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import {
  ORCHESTRATION_ATTENTION_SUMMARY_MAX,
  type OrchestrationAttentionResult,
  type OrchestrationPendingApprovalDto,
  type OrchestrationPendingHookDto,
} from '../../../shared/contracts/dto/orchestrationAttention'
import type { OrchestrationContext } from './OrchestrationService'

/**
 * A summary is a preview for a human, never the payload the executor holds. The cut counts UTF-16
 * units, as the DTO bound does, and never splits a surrogate pair.
 */
function cutSummary(summary: string): string {
  let cut = ''
  for (const char of summary) {
    if (cut.length + char.length > ORCHESTRATION_ATTENTION_SUMMARY_MAX) {
      break
    }
    cut += char
  }
  return cut
}

function pairId(key: string, currentHash: string): string {
  return `${key}\u0000${currentHash}`
}

async function pendingHooksOf(
  ctx: OrchestrationContext,
  executorNodeId: string,
): Promise<OrchestrationPendingHookDto[]> {
  const pending = ctx.slotOf(executorNodeId).pendingHooks
  const approved = await ctx.deps.hookApprovals.findApproved(
    pending.map(({ key, currentHash }) => ({ key, currentHash })),
  )
  const approvedPairs = new Set(approved.map(hook => pairId(hook.key, hook.currentHash)))
  return pending.filter(hook => !approvedPairs.has(pairId(hook.key, hook.currentHash)))
}

async function attentionLinkOf(ctx: OrchestrationContext, executorNodeId: string) {
  const approvals: OrchestrationPendingApprovalDto[] = [
    ...ctx.slotOf(executorNodeId).pendingApprovals.values(),
  ].map(approval => ({
    requestId: approval.requestId,
    kind: approval.kind,
    summary: cutSummary(approval.summary),
    turnRef: approval.turnRef,
  }))
  return {
    executorNodeId,
    approvals,
    hooks: await pendingHooksOf(ctx, executorNodeId),
  }
}

/**
 * Reads the attention the user can answer from the window: approvals held by a slot and hooks
 * still waiting for trust. Authorization stays here, as in every other orchestration use case;
 * the caller only decides which links to show.
 */
export async function pendingAttention(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  executorNodeId: string | null,
): Promise<OrchestrationAttentionResult> {
  await ctx.authorize(principal, 'orch.approval.list', executorNodeId)
  const visible = visibleLinks(principal, await ctx.deps.links.listActive())
  const selected =
    executorNodeId === null
      ? visible
      : visible.filter(link => link.executorNodeId === executorNodeId)
  if (executorNodeId !== null && selected.length === 0) {
    throw new OrchestrationError('orch.not_linked')
  }
  return {
    linksRevision: await ctx.deps.links.readLinksRevision(),
    links: await Promise.all(selected.map(link => attentionLinkOf(ctx, link.executorNodeId))),
  }
}
