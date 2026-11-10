import type { AgentLink } from '../../domain/agentLink'
import type { Dispatch } from '../../domain/dispatch'
import type { InsertLinkResult, StoredNotice } from './repositories'

export type AcceptRefusal =
  | 'link_not_active'
  | 'round_limit_reached'
  | 'id_exists'
  | 'executor_busy'

export type AcceptDispatchResult =
  | { readonly ok: true; readonly dispatch: Dispatch; readonly link: AgentLink }
  | { readonly ok: false; readonly reason: AcceptRefusal }

export type CreateLinkWithDispatchResult =
  | { readonly ok: true; readonly link: AgentLink; readonly dispatch: Dispatch | null }
  | {
      readonly ok: false
      readonly reason:
        | Exclude<Extract<InsertLinkResult, { ok: false }>['reason'], 'id_exists'>
        | AcceptRefusal
    }

export interface SettleDispatchInput {
  /** The next version of the dispatch, whose `revision` is the stored one plus one. */
  readonly next: Dispatch
  /** Gives the round back by delta in the store, never below zero. */
  readonly refundRound: boolean
  /** Already decided by the caller; the ledger never reads the state to choose it. */
  readonly notice: StoredNotice | null
  /** ISO instant written as `updatedAt` of the link. */
  readonly at: string
}

export type SettleDispatchResult =
  | {
      readonly ok: true
      readonly dispatch: Dispatch
      readonly link: AgentLink | null
      readonly noticeEnqueued: boolean
    }
  | {
      readonly ok: false
      readonly reason: 'revision_conflict' | 'not_found' | 'in_flight_conflict'
    }

/**
 * Facts that span the link, the dispatch and the notice. Each operation is one atomic step, with
 * no `await` inside it, so a failure leaves none of its writes and a concurrent one sees all.
 */
export interface DispatchLedger {
  /**
   * Consumes a round of the stored link by delta, sets `dispatch.round` from the stored counter
   * and inserts the dispatch. Any `round` the caller computed is ignored.
   */
  acceptDispatch: (dispatch: Dispatch) => Promise<AcceptDispatchResult>
  /** Inserts the link and, when given, its first dispatch with the rules of `acceptDispatch`. */
  createLinkWithDispatch: (
    link: AgentLink,
    dispatch: Dispatch | null,
  ) => Promise<CreateLinkWithDispatchResult>
  /** Compare and swap of the dispatch, with D1 on `reserved`, refund and notice in the same step. */
  settleDispatch: (input: SettleDispatchInput) => Promise<SettleDispatchResult>
}
