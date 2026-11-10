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
import { blockingError, DispatchRefusedError, settleDispatch } from './linkLifecycle'
import type { OrchestrationContext } from './OrchestrationService'
import { callRuntime } from './runtimeErrors'
import type { AcceptRefusal } from './ports'
import { currentAdmission, dispatchViewOf } from './statusView'

export interface DispatchInput {
  readonly dispatchId: string
  readonly to: string
  readonly text: string
  readonly deadlineMs?: number
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

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The `queued` dispatch of a link. Its `round` is provisional: the ledger sets the real one. */
export function queuedDispatchOf(ctx: OrchestrationContext, input: AcceptInput): Dispatch {
  const { dispatchId, link, text } = input
  return createDispatch({
    id: dispatchId,
    link,
    text,
    textSha256: sha256Of(text),
    deadlineMs: input.deadlineMs,
    now: ctx.deps.clock.now(),
  }).dispatch
}

async function refusalOf(
  ctx: OrchestrationContext,
  reason: AcceptRefusal,
  link: AgentLink,
): Promise<OrchestrationError> {
  if (reason === 'link_not_active') {
    return new OrchestrationError('orch.not_linked')
  }
  if (reason === 'round_limit_reached') {
    return new DispatchRefusedError('orch.round_limit_reached', null)
  }
  const open = await ctx.deps.dispatches.findNonFinalByExecutor(link.executorNodeId)
  return open ? blockingError(open) : new OrchestrationError('orch.dispatch_conflict')
}

/** Admission first, then the ledger takes the round and the dispatch in one step. */
export async function acceptDispatch(
  ctx: OrchestrationContext,
  input: AcceptInput,
): Promise<OrchestrationDispatchResult> {
  const { dispatches } = ctx.deps
  const { link, dispatchId } = input
  const stored = await dispatches.findById(dispatchId)
  const classified = classifyDispatchRequest(
    { id: dispatchId, executorNodeId: link.executorNodeId, textSha256: sha256Of(input.text) },
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
  const accepted = await ctx.deps.ledger.acceptDispatch(queuedDispatchOf(ctx, input))
  if (!accepted.ok) {
    throw await refusalOf(ctx, accepted.reason, link)
  }
  ctx.wake(link.executorNodeId)
  return {
    ...acceptedOf(accepted.dispatch, accepted.link),
    duplicate: false,
    admission: await currentAdmission(ctx, accepted.link, accepted.dispatch),
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
    await callRuntime(() => runtime.interrupt(open?.turnRef ?? undefined))
  })
}
