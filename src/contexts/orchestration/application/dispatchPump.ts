/* oxlint-disable no-await-in-loop -- each retry reads afresh, then writes, in order */
import type { Dispatch, DispatchEvent, DispatchState } from '../domain/dispatch'
import { sanitizeExcerpt } from '../domain/noticeComposer'
import { executorHealthOf } from './executorHealth'
import { restartIfIdle } from './hookApprovals'
import { failOpenDispatch, saveDispatch, settleDispatch, type SettleOptions } from './linkLifecycle'
import type { ExecutorSlot, OrchestrationContext } from './OrchestrationService'
import type { ExecutorRuntimeEvent } from './ports'
import { isRefusedBeforeWrite } from './runtimeErrors'

type TurnStarted = Extract<ExecutorRuntimeEvent, { type: 'turn.started' }>
type TurnCompleted = Extract<ExecutorRuntimeEvent, { type: 'turn.completed' }>

const SETTLE_ATTEMPTS = 3

/**
 * Applies an event on a dispatch read afresh by id, so a write that failed, or committed and
 * lost its answer, never leaves the retry on a stale revision. A dispatch no longer in one of
 * the `from` states was settled already and is given back as it is.
 */
async function settleFresh(
  ctx: OrchestrationContext,
  dispatchId: string,
  from: readonly DispatchState[],
  event: DispatchEvent,
  options?: SettleOptions,
): Promise<Dispatch | null> {
  let failure: unknown = null
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    try {
      const current = await ctx.deps.dispatches.findById(dispatchId)
      if (!current || !from.includes(current.state)) {
        return current
      }
      return await settleDispatch(ctx, current, event, options)
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/**
 * Sends the only `queued` dispatch of the executor when nothing blocks it. A service waiting for
 * a restart is restarted first, and its start waking the pump again is what sends the work.
 */
export async function pumpExecutor(
  ctx: OrchestrationContext,
  executorNodeId: string,
): Promise<void> {
  if (!ctx.bootDone()) {
    return
  }
  const { links, dispatches, clock } = ctx.deps
  const link = await links.findActiveByExecutor(executorNodeId)
  if (!link) {
    return
  }
  const slot = ctx.slotOf(executorNodeId)
  const health = executorHealthOf(slot.health)
  if (health === 'unavailable') {
    const open = await dispatches.findNonFinalByExecutor(executorNodeId)
    if (open) {
      await failOpenDispatch(ctx, open)
    }
    return
  }
  if (
    !slot.runtime ||
    health !== 'ready' ||
    (await dispatches.findInFlightByExecutor(executorNodeId))
  ) {
    return
  }
  if (slot.restartPending) {
    await restartIfIdle(ctx, slot).catch(() => undefined)
    return
  }
  const queued = await dispatches.findOldestQueuedByExecutor(executorNodeId)
  if (!queued?.text) {
    return
  }
  const reserved = await settleDispatch(
    ctx,
    queued,
    { type: 'reserve', now: clock.now() },
    { notice: 'none' },
  )
  if (reserved.state === 'reserved') {
    await sendReserved(ctx, slot, reserved)
  }
}

async function sendReserved(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  reserved: Dispatch,
): Promise<void> {
  const now = ctx.deps.clock.now()
  let event: DispatchEvent
  try {
    const { turnRef } = await slot.runtime!.startTurn({
      dispatchId: reserved.id,
      text: reserved.text!,
    })
    event = { type: 'service_accepted', turnRef, now }
  } catch (error) {
    event = { type: isRefusedBeforeWrite(error) ? 'service_rejected' : 'send_uncertain', now }
  }
  await settleFresh(ctx, reserved.id, ['reserved'], event)
}

async function dispatchOf(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  event: TurnStarted | TurnCompleted,
): Promise<Dispatch | null> {
  const { dispatches } = ctx.deps
  if (event.dispatchId) {
    return dispatches.findById(event.dispatchId)
  }
  const open = await dispatches.findInFlightByExecutor(slot.executorNodeId)
  return open?.turnRef === event.turnRef ? open : null
}

/** The service says it runs the turn of a dispatch whose own acceptance was never recorded. */
function acceptReserved(
  ctx: OrchestrationContext,
  reserved: Dispatch,
  turnRef: string,
  glimpseTurnId: string | null,
): Promise<Dispatch | null> {
  const event = {
    type: 'service_accepted',
    turnRef,
    glimpseTurnId,
    now: ctx.deps.clock.now(),
  } as const
  return settleFresh(ctx, reserved.id, ['reserved'], event)
}

async function onTurnStarted(ctx: OrchestrationContext, slot: ExecutorSlot, event: TurnStarted) {
  const { glimpseTurnId } = await ctx.deps.runState.recordTurnStarted({
    executorNodeId: slot.executorNodeId,
    turnRef: event.turnRef,
    origin: event.origin,
    text: null,
  })
  slot.turns.set(event.turnRef, glimpseTurnId)
  const dispatch = await dispatchOf(ctx, slot, event)
  if (dispatch?.state === 'reserved' && event.dispatchId === dispatch.id) {
    await acceptReserved(ctx, dispatch, event.turnRef, glimpseTurnId)
  } else if (dispatch?.state === 'sent' && !dispatch.glimpseTurnId) {
    await saveDispatch(ctx, { ...dispatch, glimpseTurnId, revision: dispatch.revision + 1 })
  }
}

async function onTurnCompleted(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  event: TurnCompleted,
) {
  const glimpseTurnId = slot.turns.get(event.turnRef) ?? null
  slot.turns.delete(event.turnRef)
  if (glimpseTurnId) {
    await ctx.deps.runState.recordTurnCompleted({
      executorNodeId: slot.executorNodeId,
      turnRef: event.turnRef,
      glimpseTurnId,
      outcome: event.outcome,
      finalMessage: event.finalMessage,
    })
  }
  let dispatch = await dispatchOf(ctx, slot, event)
  if (dispatch?.state === 'reserved' && event.dispatchId === dispatch.id) {
    dispatch = await acceptReserved(ctx, dispatch, event.turnRef, glimpseTurnId)
  }
  if (dispatch && (dispatch.state === 'sent' || dispatch.state === 'uncertain')) {
    await settleDispatch(ctx, dispatch, {
      type: 'turn_finished',
      outcome: event.outcome,
      finalExcerpt: event.finalMessage === null ? null : sanitizeExcerpt(event.finalMessage),
      finalChars: event.finalMessage?.length ?? null,
      glimpseTurnId: glimpseTurnId ?? dispatch.glimpseTurnId,
      now: ctx.deps.clock.now(),
    })
  }
}

/** Turn and readiness events of the runtime, handled inside the executor exclusion. */
export async function handleTurnEvent(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  event: ExecutorRuntimeEvent,
): Promise<void> {
  if (event.type === 'turn.started') {
    await onTurnStarted(ctx, slot, event)
    return
  }
  if (event.type === 'turn.completed') {
    await onTurnCompleted(ctx, slot, event)
  }
  if (event.type === 'turn.completed' || event.type === 'executor.ready') {
    await pumpExecutor(ctx, slot.executorNodeId)
  }
}
