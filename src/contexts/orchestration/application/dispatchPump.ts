import { transitionDispatch, type Dispatch } from '../domain/dispatch'
import { sanitizeExcerpt } from '../domain/noticeComposer'
import { executorHealthOf } from './executorHealth'
import { failOpenDispatch, saveDispatch, settleDispatch } from './linkLifecycle'
import type { ExecutorSlot, OrchestrationContext } from './OrchestrationService'
import type { ExecutorRuntimeEvent } from './ports'

type TurnStarted = Extract<ExecutorRuntimeEvent, { type: 'turn.started' }>
type TurnCompleted = Extract<ExecutorRuntimeEvent, { type: 'turn.completed' }>

const REFUSED_BEFORE_WRITE = new Set([
  'executor.rejected',
  'executor.busy',
  'executor.unavailable',
  'executor.session_lost',
  'executor.unsupported',
])

function isRefusedBeforeWrite(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && REFUSED_BEFORE_WRITE.has(code)
}

/** Reserves and sends the only `queued` dispatch of the executor, when nothing blocks it. */
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
  const queued = await dispatches.findOldestQueuedByExecutor(executorNodeId)
  if (!queued?.text) {
    return
  }
  const reserved = await saveDispatch(
    ctx,
    transitionDispatch(queued, { type: 'reserve', now: clock.now() }).dispatch,
  )
  if (!reserved) {
    return
  }
  await sendReserved(ctx, slot, reserved)
}

async function sendReserved(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  reserved: Dispatch,
): Promise<void> {
  const now = ctx.deps.clock.now()
  try {
    const { turnRef } = await slot.runtime!.startTurn({
      dispatchId: reserved.id,
      text: reserved.text!,
    })
    await settleDispatch(ctx, reserved, { type: 'service_accepted', turnRef, now })
  } catch (error) {
    const type = isRefusedBeforeWrite(error) ? 'service_rejected' : 'send_uncertain'
    await settleDispatch(ctx, reserved, { type, now })
  }
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

async function onTurnStarted(ctx: OrchestrationContext, slot: ExecutorSlot, event: TurnStarted) {
  const { glimpseTurnId } = await ctx.deps.runState.recordTurnStarted({
    executorNodeId: slot.executorNodeId,
    turnRef: event.turnRef,
    origin: event.origin,
    text: null,
  })
  slot.turns.set(event.turnRef, glimpseTurnId)
  const dispatch = await dispatchOf(ctx, slot, event)
  if (dispatch?.state === 'sent' && !dispatch.glimpseTurnId) {
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
  const dispatch = await dispatchOf(ctx, slot, event)
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
