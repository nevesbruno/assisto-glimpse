import { OrchestrationError } from '../domain/agentLink'
import type { OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import type { ExecutorSlot, OrchestrationContext } from './OrchestrationService'
import type { ApprovalDecision, ExecutorRuntimeEvent } from './ports'

export type ApprovalAnswer = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export interface RespondApprovalInput {
  readonly executorNodeId: string
  readonly requestId: string
  readonly decision: ApprovalAnswer
}

/** The runtime port only knows approve and deny, so `acceptForSession` approves this request alone. */
const PORT_DECISION: Record<ApprovalAnswer, ApprovalDecision> = {
  accept: 'approve',
  acceptForSession: 'approve',
  decline: 'deny',
  cancel: 'deny',
}

export async function respondApproval(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  input: RespondApprovalInput,
): Promise<void> {
  await ctx.authorize(principal, 'orch.approval.respond', input.executorNodeId)
  const { executorNodeId, requestId } = input
  if (!(await ctx.deps.links.findActiveByExecutor(executorNodeId))) {
    throw new OrchestrationError('orch.not_linked')
  }
  const slot = ctx.slotOf(executorNodeId)
  const result = slot.runtime
    ? await slot.runtime.respondApproval(requestId, PORT_DECISION[input.decision])
    : { ok: false as const }
  slot.pendingApprovals.delete(requestId)
  if (!result.ok) {
    await ctx.deps.runState.recordApprovalResolved(executorNodeId, requestId)
    throw new OrchestrationError('orch.approval_not_found')
  }
}

/** Mirrors the request and its resolution into the run state of the executor node. */
export async function recordApprovalEvent(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  event: ExecutorRuntimeEvent,
): Promise<void> {
  if (event.type === 'approval.requested') {
    await ctx.deps.runState.recordWaitingForApproval(slot.executorNodeId, event.requestId)
  } else if (event.type === 'approval.resolved') {
    await ctx.deps.runState.recordApprovalResolved(slot.executorNodeId, event.requestId)
  }
}
