/* oxlint-disable no-await-in-loop -- the retry reads, then writes, in order */
import { closeLink, OrchestrationError, type AgentLink } from '../domain/agentLink'
import {
  isFinalDispatchState,
  transitionDispatch,
  type Dispatch,
  type DispatchEvent,
} from '../domain/dispatch'
import type { NoticeKind } from '../domain/noticeComposer'
import type { RoundExtension } from '../domain/roundPolicy'
import type { OrchestrationContext } from './OrchestrationService'
import { callRuntime } from './runtimeErrors'
import type { ExecutorCloseReason, StoredNotice } from './ports'

const CAS_ATTEMPTS = 5

export class DispatchRefusedError extends OrchestrationError {
  public constructor(
    code: 'orch.dispatch_in_flight' | 'orch.round_limit_reached' | 'orch.executor_unavailable',
    public readonly blocking: { dispatchId: string; state: string; round: number } | null,
  ) {
    super(code)
    this.name = 'DispatchRefusedError'
  }
}

export function blockingError(dispatch: Dispatch): DispatchRefusedError {
  return new DispatchRefusedError('orch.dispatch_in_flight', {
    dispatchId: dispatch.id,
    state: dispatch.state,
    round: dispatch.round,
  })
}

export async function updateLink(
  ctx: OrchestrationContext,
  linkId: string,
  change: (link: AgentLink) => AgentLink,
): Promise<AgentLink> {
  const { links, events, clock } = ctx.deps
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await links.findById(linkId)
    if (!current) {
      throw new OrchestrationError('orch.not_linked')
    }
    const changed = change(current)
    const next = {
      ...changed,
      revision: current.revision + 1,
      updatedAt: clock.now().toISOString(),
    }
    const result = await links.update(next)
    if (result.ok) {
      events.publishLinksUpdated({
        linksRevision: await links.readLinksRevision(),
        projectIds: [next.projectId],
      })
      return result.value
    }
    if (result.reason === 'not_found') {
      throw new OrchestrationError('orch.not_linked')
    }
  }
  throw new Error(`link ${linkId} kept changing, gave up after ${CAS_ATTEMPTS} attempts`)
}

export async function saveDispatch(
  ctx: OrchestrationContext,
  next: Dispatch,
): Promise<Dispatch | null> {
  const result = await ctx.deps.dispatches.update(next)
  if (result.ok) {
    return result.value
  }
  if (result.reason === 'in_flight_conflict') {
    return null
  }
  throw new Error(`dispatch ${next.id} update failed: ${result.reason}`)
}

function noticeKindOf(dispatch: Dispatch): NoticeKind | null {
  if (dispatch.state === 'completed') {
    return 'completed'
  }
  if (dispatch.state === 'uncertain') {
    return 'uncertain'
  }
  if (dispatch.state !== 'failed') {
    return null
  }
  const byReason: Record<string, NoticeKind> = {
    not_sent: 'failed_not_sent',
    executor_down: 'executor_down_in_turn',
    turn_failed: 'failed_turn_failed',
    interrupted: 'interrupted',
  }
  return dispatch.reason ? (byReason[dispatch.reason] ?? null) : null
}

async function noticeOf(
  ctx: OrchestrationContext,
  dispatch: Dispatch,
  link: AgentLink,
): Promise<StoredNotice | null> {
  const kind = noticeKindOf(dispatch)
  if (!kind) {
    return null
  }
  const { nodes, clock, ids } = ctx.deps
  const node = await nodes.findNode(dispatch.executorNodeId)
  const createdAt = clock.now().toISOString()
  return {
    id: ids.uuid(),
    orchestratorNodeId: dispatch.orchestratorNodeId,
    dedupeKey: `${dispatch.id}:${dispatch.state}`,
    state: 'pending',
    batchId: null,
    settledAt: null,
    createdAt,
    entry: {
      executorNodeId: dispatch.executorNodeId,
      executorName: node?.title ?? dispatch.executorNodeId,
      provider: link.provider,
      kind,
      round: dispatch.round,
      roundsLimit: link.roundsLimit,
      dispatchId: dispatch.id,
      glimpseTurnId: dispatch.glimpseTurnId,
      excerpt: dispatch.finalExcerpt,
      createdAt,
    },
  }
}

export async function enqueueNotice(
  ctx: OrchestrationContext,
  dispatch: Dispatch,
  link: AgentLink,
): Promise<void> {
  const notice = await noticeOf(ctx, dispatch, link)
  if (notice) {
    await ctx.deps.notices.enqueue(notice)
  }
}

export interface SettleOptions {
  /** `final` queues the notice the new state calls for; `none` queues nothing. */
  readonly notice?: 'final' | 'none'
}

/** Applies one domain event: dispatch, round refund and notice are one step of the ledger. */
export async function settleDispatch(
  ctx: OrchestrationContext,
  dispatch: Dispatch,
  event: DispatchEvent,
  options: SettleOptions = {},
): Promise<Dispatch> {
  const { ledger, links, events, clock } = ctx.deps
  const transition = transitionDispatch(dispatch, event)
  const before = await links.findById(dispatch.linkId)
  const notice =
    options.notice === 'none' || !before ? null : await noticeOf(ctx, transition.dispatch, before)
  const result = await ledger.settleDispatch({
    next: transition.dispatch,
    refundRound: transition.returnsRound,
    notice,
    at: clock.now().toISOString(),
  })
  if (!result.ok) {
    if (result.reason === 'in_flight_conflict') {
      return dispatch
    }
    throw new Error(`dispatch ${dispatch.id} update failed: ${result.reason}`)
  }
  if (transition.returnsRound && result.link) {
    events.publishLinksUpdated({
      linksRevision: await links.readLinksRevision(),
      projectIds: [result.link.projectId],
    })
  }
  if (event.type === 'executor_down') {
    await ctx.deps.runState.recordExecutorDown(result.dispatch.executorNodeId)
  }
  return result.dispatch
}

/** Fails the open dispatch of an executor that stopped being able to run it. */
export async function failOpenDispatch(
  ctx: OrchestrationContext,
  dispatch: Dispatch,
): Promise<void> {
  const now = ctx.deps.clock.now()
  let current = dispatch
  if (current.state === 'queued') {
    await settleDispatch(ctx, current, { type: 'executor_unavailable', now })
    return
  }
  if (current.state === 'reserved') {
    current = await settleDispatch(
      ctx,
      current,
      { type: 'send_uncertain', now },
      { notice: 'none' },
    )
  }
  await settleDispatch(ctx, current, { type: 'executor_down', now })
}

const RUNTIME_CLOSE_REASON: Record<string, ExecutorCloseReason> = {
  user: 'user',
  node_deleted: 'node_deleted',
}

export async function closeExecutorLink(
  ctx: OrchestrationContext,
  link: AgentLink,
  reason: 'orchestrator' | 'user' | 'node_deleted' | 'spawn_failed',
  force: boolean,
): Promise<AgentLink> {
  const open = await ctx.deps.dispatches.findNonFinalByExecutor(link.executorNodeId)
  if (open && open.state !== 'queued' && !force) {
    throw blockingError(open)
  }
  if (open && !isFinalDispatchState(open.state)) {
    if (open.state === 'queued') {
      await settleDispatch(ctx, open, { type: 'cancel', now: ctx.deps.clock.now() })
    } else {
      await failOpenDispatch(ctx, open)
    }
  }
  const closed = await updateLink(ctx, link.id, current =>
    closeLink(current, reason, ctx.deps.clock.now()),
  )
  const slot = ctx.slotOf(link.executorNodeId)
  slot.unsubscribe?.()
  slot.unsubscribe = null
  const runtime = slot.runtime
  slot.runtime = null
  try {
    ctx.deps.tui.retire(link.executorNodeId)
  } catch {
    // The link is already closed; a TUI that survives only costs a dead PTY.
  }
  if (runtime) {
    await callRuntime(() => runtime.close(RUNTIME_CLOSE_REASON[reason] ?? 'link_closed'))
  }
  return closed
}

export async function extendLinkRounds(
  ctx: OrchestrationContext,
  linkId: string,
  rounds: RoundExtension,
): Promise<AgentLink> {
  const { links, events, clock } = ctx.deps
  const known = await links.findById(linkId)
  if (!known) {
    throw new OrchestrationError('orch.not_linked')
  }
  return ctx.runExclusive(known.executorNodeId, async () => {
    const link = await links.extendRounds(linkId, rounds, clock.now().toISOString())
    if (!link) {
      throw new OrchestrationError('orch.not_linked')
    }
    events.publishLinksUpdated({
      linksRevision: await links.readLinksRevision(),
      projectIds: [link.projectId],
    })
    ctx.wake(link.executorNodeId)
    return link
  })
}
