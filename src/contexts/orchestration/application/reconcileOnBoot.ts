import type { Dispatch, DispatchEvent } from '../domain/dispatch'
import type { AgentLink } from '../domain/agentLink'
import { sanitizeExcerpt } from '../domain/noticeComposer'
import { reconcileDeletedNodes } from './nodeDeletion'
import { executorHealthOf } from './executorHealth'
import { enqueueNotice, failOpenDispatch, settleDispatch } from './linkLifecycle'
import type { ExecutorSlot, OrchestrationContext } from './OrchestrationService'
import type { ExecutorRuntimeEvent, ExecutorTurnSnapshot, FindTurnResult } from './ports'
import { recordServiceIdentity } from './serviceIdentity'
import { restartLinkedService } from './spawnExecutor'

const UNKNOWN: FindTurnResult = { kind: 'unknown' }

function eventOfFound(
  dispatch: Dispatch,
  turn: ExecutorTurnSnapshot,
  now: Date,
): DispatchEvent | null {
  if (turn.status === 'running') {
    return dispatch.state === 'uncertain'
      ? { type: 'turn_found_running', turnRef: turn.turnRef, now }
      : null
  }
  if (turn.status === 'interrupted') {
    return { type: 'executor_down', now }
  }
  return {
    type: 'turn_finished',
    outcome: turn.status,
    finalExcerpt: turn.finalMessage === null ? null : sanitizeExcerpt(turn.finalMessage),
    finalChars: turn.finalMessage?.length ?? null,
    now,
  }
}

function eventOf(dispatch: Dispatch, result: FindTurnResult, now: Date): DispatchEvent | null {
  if (result.kind === 'found') {
    return eventOfFound(dispatch, result.turn, now)
  }
  if (result.kind === 'unknown') {
    return null
  }
  return { type: dispatch.state === 'uncertain' ? 'turn_absent' : 'executor_down', now }
}

/** The turn runs but the run state never saw it start: opens it, once per turn of this Worker. */
async function adoptRunningTurn(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  turnRef: string,
): Promise<string> {
  const known = slot.turns.get(turnRef)
  if (known) {
    return known
  }
  const { glimpseTurnId } = await ctx.deps.runState.recordTurnStarted({
    executorNodeId: slot.executorNodeId,
    turnRef,
    origin: 'glimpse',
    text: null,
  })
  slot.turns.set(turnRef, glimpseTurnId)
  return glimpseTurnId
}

/** Asks the service for the turn of an `uncertain` or `sent` dispatch and settles what it proves. */
async function resolveInFlight(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  open: Dispatch,
): Promise<void> {
  const since = new Date(open.reservedAt ?? open.createdAt)
  const result = await slot.runtime!.findTurnByDispatch(open.id, since).catch(() => UNKNOWN)
  const running =
    result.kind === 'found' && result.turn.status === 'running' ? result.turn.turnRef : null
  const glimpseTurnId = running ? await adoptRunningTurn(ctx, slot, running) : null
  const base = eventOf(open, result, ctx.deps.clock.now())
  const event = base?.type === 'turn_found_running' ? { ...base, glimpseTurnId } : base
  if (event) {
    await settleDispatch(ctx, open, event)
    return
  }
  const link = await ctx.deps.links.findById(open.linkId)
  if (link && open.state === 'uncertain') {
    await enqueueNotice(ctx, open, link)
  }
}

async function markReservedUncertain(ctx: OrchestrationContext, executorNodeId: string) {
  const open = await ctx.deps.dispatches.findInFlightByExecutor(executorNodeId)
  if (open?.state === 'reserved') {
    await settleDispatch(
      ctx,
      open,
      { type: 'send_uncertain', now: ctx.deps.clock.now() },
      { notice: 'none' },
    )
  }
}

async function reconcileLink(ctx: OrchestrationContext, link: AgentLink): Promise<void> {
  if (ctx.deps.isStopped?.()) {
    return
  }
  const slot = ctx.slotOf(link.executorNodeId)
  try {
    await restartLinkedService(ctx, link)
  } catch {
    ctx.onRuntimeEvent(slot, { type: 'service.unavailable' })
  }
  const open = await ctx.deps.dispatches.findInFlightByExecutor(link.executorNodeId)
  if (!open) {
    return
  }
  if (executorHealthOf(slot.health) === 'unavailable') {
    await failOpenDispatch(ctx, open)
    return
  }
  await resolveInFlight(ctx, slot, open)
}

/** Steps 1 to 6 of the restart reconciliation; the pump only runs after the last one. */
export async function reconcileOnBoot(ctx: OrchestrationContext): Promise<void> {
  const each = (list: readonly AgentLink[], task: (link: AgentLink) => Promise<void>) =>
    Promise.all(list.map(link => ctx.runExclusive(link.executorNodeId, () => task(link))))
  const links = await ctx.deps.links.listActive()
  await each(links, link => markReservedUncertain(ctx, link.executorNodeId))
  await ctx.deps.reapOrphanServices?.(links)
  await reconcileDeletedNodes(ctx)
  await each(await ctx.deps.links.listActive(), link => reconcileLink(ctx, link))
  await ctx.finishBoot()
}

type Incident = Extract<ExecutorRuntimeEvent, { type: 'executor.down' | 'executor.recovered' }>

/** The service died or came back while the Worker kept running. */
export async function handleExecutorIncident(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
  event: Incident,
): Promise<void> {
  await markReservedUncertain(ctx, slot.executorNodeId)
  if (event.type === 'executor.down') {
    return
  }
  const link = await ctx.deps.links.findActiveByExecutor(slot.executorNodeId)
  if (link && slot.runtime) {
    await recordServiceIdentity(ctx, link.id, slot.runtime)
  }
  const open = await ctx.deps.dispatches.findInFlightByExecutor(slot.executorNodeId)
  if (open) {
    await resolveInFlight(ctx, slot, open)
  }
  await ctx.deps.runState.recordExecutorRecovered(slot.executorNodeId)
  ctx.onRuntimeEvent(slot, { type: 'reconciliation.finished' })
}
