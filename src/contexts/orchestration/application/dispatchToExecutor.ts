import { createHash } from 'node:crypto'
import { OrchestrationError, type AgentLink } from '../domain/agentLink'
import {
  classifyDispatchRequest,
  createDispatch,
  isFinalDispatchState,
  type Dispatch,
} from '../domain/dispatch'
import type { OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import type {
  OrchestrationDispatchResult,
  OrchestrationDispatchView,
} from '../../../shared/contracts/dto/orchestration'
import { blockingError, DispatchRefusedError, settleDispatch, updateLink } from './linkLifecycle'
import type { OrchestrationContext } from './OrchestrationService'
import { currentAdmission, dispatchViewOf } from './statusView'

export interface DispatchInput {
  readonly dispatchId: string
  readonly to: string
  readonly text: string
  readonly deadlineMs?: number
  /** Accepted and not persisted: the domain has no field for it yet. */
  readonly fresh?: boolean
}

export function acceptedOf(dispatch: Dispatch, link: AgentLink) {
  return {
    dispatchId: dispatch.id,
    state: dispatch.state,
    round: dispatch.round,
    roundsLimit: link.roundsLimit,
  }
}

export interface AcceptInput {
  readonly dispatchId: string
  readonly link: AgentLink
  readonly text: string
  readonly deadlineMs?: number
}

/** Admission first, then the round and the dispatch. Runs inside the executor exclusion. */
export async function acceptDispatch(
  ctx: OrchestrationContext,
  input: AcceptInput,
): Promise<OrchestrationDispatchResult> {
  const { dispatches, clock } = ctx.deps
  const { link, dispatchId, text } = input
  const textSha256 = createHash('sha256').update(text).digest('hex')
  const stored = await dispatches.findById(dispatchId)
  const classified = classifyDispatchRequest(
    { id: dispatchId, executorNodeId: link.executorNodeId, textSha256 },
    stored ? [stored] : [],
  )
  if (classified.kind === 'duplicate') {
    const current = (await ctx.deps.links.findById(link.id)) ?? link
    return {
      ...acceptedOf(classified.dispatch, current),
      duplicate: true,
      admission: await currentAdmission(ctx, current),
    }
  }

  const admission = await currentAdmission(ctx, link)
  if (!admission.canDispatch) {
    throw new DispatchRefusedError(
      `orch.${admission.reason!}`,
      admission.blocking && { ...admission.blocking },
    )
  }
  const { dispatch, rounds } = createDispatch({
    id: dispatchId,
    link,
    text,
    textSha256,
    deadlineMs: input.deadlineMs,
    now: clock.now(),
  })
  const inserted = await dispatches.insert(dispatch)
  if (!inserted.ok) {
    const open = await dispatches.findNonFinalByExecutor(link.executorNodeId)
    throw open ? blockingError(open) : new OrchestrationError('orch.dispatch_conflict')
  }
  const updated = await updateLink(ctx, link.id, current => ({ ...current, ...rounds }))
  ctx.wake(link.executorNodeId)
  return {
    ...acceptedOf(inserted.value, updated),
    duplicate: false,
    admission: await currentAdmission(ctx, updated, inserted.value),
  }
}

export async function dispatchToExecutor(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  input: DispatchInput,
): Promise<OrchestrationDispatchResult> {
  await ctx.authorize(principal, 'orch.dispatch', input.to)
  return ctx.runExclusive(input.to, async () => {
    const link = await ctx.deps.links.findActiveByExecutor(input.to)
    if (!link) {
      throw new OrchestrationError('orch.not_linked')
    }
    return acceptDispatch(ctx, { ...input, link })
  })
}

export async function cancelDispatch(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  dispatchId: string,
): Promise<OrchestrationDispatchView> {
  const target = await ctx.deps.dispatches.findById(dispatchId)
  await ctx.authorize(principal, 'orch.cancel', target?.executorNodeId ?? null)
  if (!target) {
    throw new OrchestrationError('orch.not_linked')
  }
  return ctx.runExclusive(target.executorNodeId, async () => {
    const current = (await ctx.deps.dispatches.findById(dispatchId))!
    if (isFinalDispatchState(current.state)) {
      return dispatchViewOf(current)
    }
    if (current.state !== 'queued') {
      throw blockingError(current)
    }
    const cancelled = await settleDispatch(ctx, current, {
      type: 'cancel',
      now: ctx.deps.clock.now(),
    })
    return dispatchViewOf(cancelled)
  })
}

export async function interruptExecutor(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  to: string,
): Promise<void> {
  await ctx.authorize(principal, 'orch.interrupt', to)
  await ctx.runExclusive(to, async () => {
    const runtime = ctx.slotOf(to).runtime
    if (!runtime) {
      throw new OrchestrationError('orch.executor_unavailable')
    }
    const open = await ctx.deps.dispatches.findInFlightByExecutor(to)
    await runtime.interrupt(open?.turnRef ?? undefined)
  })
}
