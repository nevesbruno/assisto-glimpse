import type {
  AcceptDispatchResult,
  AcceptRefusal,
  CreateLinkWithDispatchResult,
  DispatchLedger,
  SettleDispatchInput,
  SettleDispatchResult,
} from '../../application/ports'
import type { AgentLink } from '../../domain/agentLink'
import type { Dispatch } from '../../domain/dispatch'
import {
  insertLinkRefusal,
  insertLinkRow,
  readLinkRow,
  shiftLinkCounter,
} from './SqliteAgentLinkRepository'
import {
  casDispatchRow,
  findOpenDispatchRow,
  hasOtherInFlightRow,
  insertDispatchRow,
  readDispatchRow,
} from './SqliteDispatchRepository'
import { insertNoticeRow } from './SqliteNoticeOutboxRepository'
import { runInTransaction, type SqliteHandle } from './sqliteHandle'

/** Thrown inside a step to undo its writes and answer the refusal instead of failing. */
class Refusal<R extends string> extends Error {
  public constructor(public readonly reason: R) {
    super(reason)
  }
}

/** Runs a step and turns its `Refusal` into a result, after the rollback. */
function attempt<T>(db: SqliteHandle, step: () => T) {
  try {
    return runInTransaction(db, step)
  } catch (error) {
    if (error instanceof Refusal) {
      return { ok: false, reason: error.reason } as const
    }
    throw error
  }
}

/** Reads the stored link, checks the rules and moves the counter; returns the stored dispatch. */
function acceptStep(db: SqliteHandle, dispatch: Dispatch): { dispatch: Dispatch; link: AgentLink } {
  const stored = readLinkRow(db, dispatch.linkId)
  if (!stored || stored.state !== 'active') {
    throw new Refusal<AcceptRefusal>('link_not_active')
  }
  if (stored.roundsUsed >= stored.roundsLimit) {
    throw new Refusal<AcceptRefusal>('round_limit_reached')
  }
  if (readDispatchRow(db, dispatch.id)) {
    throw new Refusal<AcceptRefusal>('id_exists')
  }
  if (findOpenDispatchRow(db, dispatch.executorNodeId)) {
    throw new Refusal<AcceptRefusal>('executor_busy')
  }
  shiftLinkCounter(db, stored.id, 'consume', dispatch.createdAt)
  const next = { ...dispatch, round: stored.roundsUsed + 1 }
  insertDispatchRow(db, next)
  return { dispatch: next, link: readLinkRow(db, stored.id)! }
}

export class SqliteDispatchLedger implements DispatchLedger {
  public constructor(private readonly db: SqliteHandle) {}

  public async acceptDispatch(dispatch: Dispatch): Promise<AcceptDispatchResult> {
    const result = attempt(this.db, () => acceptStep(this.db, dispatch))
    return 'ok' in result ? result : { ok: true, ...result }
  }

  public async createLinkWithDispatch(
    link: AgentLink,
    dispatch: Dispatch | null,
  ): Promise<CreateLinkWithDispatchResult> {
    const result = attempt(this.db, () => {
      try {
        insertLinkRow(this.db, link)
      } catch (error) {
        const reason = insertLinkRefusal(error)
        throw reason ? new Refusal(reason) : error
      }
      return dispatch
        ? acceptStep(this.db, dispatch)
        : { dispatch: null, link: readLinkRow(this.db, link.id)! }
    })
    return 'ok' in result ? result : { ok: true, ...result }
  }

  public async settleDispatch(input: SettleDispatchInput): Promise<SettleDispatchResult> {
    const { next, refundRound, notice, at } = input
    const result = attempt(this.db, () => {
      if (next.state === 'reserved' && hasOtherInFlightRow(this.db, next)) {
        throw new Refusal('in_flight_conflict' as const)
      }
      const outcome = casDispatchRow(this.db, next)
      if (outcome !== 'ok') {
        throw new Refusal(outcome)
      }
      if (refundRound) {
        shiftLinkCounter(this.db, next.linkId, 'refund', at)
      }
      const noticeEnqueued = notice ? insertNoticeRow(this.db, notice) : false
      return { dispatch: next, link: readLinkRow(this.db, next.linkId), noticeEnqueued }
    })
    return 'ok' in result ? result : { ok: true, ...result }
  }
}
