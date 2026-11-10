import { OrchestrationError } from '../domain/agentLink'
import type { OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import type { ExecutorSlot, OrchestrationContext } from './OrchestrationService'
import type { ApprovalDecision, ExecutorRuntimeEvent } from './ports'
import { callRuntime } from './runtimeErrors'

export type ApprovalAnswer = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export interface RespondApprovalInput {
  readonly executorNodeId: string
  readonly requestId: string
  readonly decision: ApprovalAnswer
}

const PORT_DECISION: Record<ApprovalAnswer, ApprovalDecision> = {
  accept: 'approve',
  acceptForSession: 'approve_for_session',
  decline: 'deny',
  cancel: 'cancel',
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
  const { runtime } = slot
  if (!runtime) {
    throw new OrchestrationError('orch.executor_unavailable')
  }
  const result = await callRuntime(() =>
    runtime.respondApproval(requestId, PORT_DECISION[input.decision]),
  )
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
    await ctx.deps.runState.recordWaitingForApproval(
      slot.executorNodeId,
      event.requestId,
      event.summary,
    )
  } else if (event.type === 'approval.resolved') {
    await ctx.deps.runState.recordApprovalResolved(slot.executorNodeId, event.requestId)
  }
}
