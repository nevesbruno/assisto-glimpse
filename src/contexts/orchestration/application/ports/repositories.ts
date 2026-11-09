import type { AgentLink } from '../../domain/agentLink'
import type { Dispatch, DispatchState } from '../../domain/dispatch'
import type { NoticeEntry } from '../../domain/noticeComposer'

/**
 * Compare and swap by `revision`. The caller passes the next version of the record, whose
 * `revision` is the stored one plus one; the store applies it only when that holds.
 */
export type CasResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'revision_conflict' | 'not_found' }

export type InsertLinkResult =
  | { readonly ok: true; readonly value: AgentLink }
  | {
      readonly ok: false
      readonly reason: 'executor_already_linked' | 'spawn_request_duplicate' | 'id_exists'
    }

export type InsertDispatchResult =
  | { readonly ok: true; readonly value: Dispatch }
  | { readonly ok: false; readonly reason: 'id_exists' }

export type UpdateDispatchResult =
  | CasResult<Dispatch>
  | { readonly ok: false; readonly reason: 'in_flight_conflict' }

export interface AgentLinkRepository {
  insert: (link: AgentLink) => Promise<InsertLinkResult>
  update: (next: AgentLink) => Promise<CasResult<AgentLink>>
  findById: (linkId: string) => Promise<AgentLink | null>
  findActiveByExecutor: (executorNodeId: string) => Promise<AgentLink | null>
  findBySpawnRequest: (
    orchestratorNodeId: string,
    spawnRequestId: string,
  ) => Promise<AgentLink | null>
  listActiveByOrchestrator: (orchestratorNodeId: string) => Promise<readonly AgentLink[]>
  listActive: () => Promise<readonly AgentLink[]>
  listByProject: (projectId: string | null) => Promise<readonly AgentLink[]>
  /** Monotonic counter bumped on every change, exposed as `linksRevision`. */
  readLinksRevision: () => Promise<number>
}

export interface DispatchRepository {
  insert: (dispatch: Dispatch) => Promise<InsertDispatchResult>
  /** Moving into `reserved` fails with `in_flight_conflict` when D1 would break. */
  update: (next: Dispatch) => Promise<UpdateDispatchResult>
  findById: (dispatchId: string) => Promise<Dispatch | null>
  findInFlightByExecutor: (executorNodeId: string) => Promise<Dispatch | null>
  /** FIFO by `createdAt`. */
  findOldestQueuedByExecutor: (executorNodeId: string) => Promise<Dispatch | null>
  listByLink: (linkId: string) => Promise<readonly Dispatch[]>
  listByStates: (states: readonly DispatchState[]) => Promise<readonly Dispatch[]>
  /** Non final dispatches of an executor with the same content hash created since the date (D6). */
  listRecentNonFinalByHash: (
    executorNodeId: string,
    textSha256: string,
    since: Date,
  ) => Promise<readonly Dispatch[]>
}

export type NoticeDeliveryState = 'pending' | 'delivered' | 'uncertain'

export interface StoredNotice {
  readonly id: string
  readonly orchestratorNodeId: string
  readonly dedupeKey: string
  readonly entry: NoticeEntry
  readonly state: NoticeDeliveryState
  readonly batchId: string | null
  readonly createdAt: string
  readonly settledAt: string | null
}

export type EnqueueNoticeResult = { readonly enqueued: true } | { readonly enqueued: false }

export interface NoticeOutboxRepository {
  /** Deduplicated by `dedupeKey`, for instance `dispatchId:state`. */
  enqueue: (notice: StoredNotice) => Promise<EnqueueNoticeResult>
  listPending: (orchestratorNodeId: string) => Promise<readonly StoredNotice[]>
  listUncertain: (orchestratorNodeId: string) => Promise<readonly StoredNotice[]>
  /** Marks the whole batch with one delivery id. */
  settleBatch: (
    noticeIds: readonly string[],
    batchId: string,
    state: Exclude<NoticeDeliveryState, 'pending'>,
    settledAt: Date,
  ) => Promise<void>
  /** Drops notices of an orchestrator whose link closed with nobody left to read them. */
  deleteByOrchestrator: (orchestratorNodeId: string) => Promise<void>
}

export interface HookApproval {
  readonly executorNodeId: string
  readonly key: string
  readonly approvedHash: string
  readonly approvedAt: string
}

export interface HookApprovalRepository {
  list: (executorNodeId: string) => Promise<readonly HookApproval[]>
  upsertMany: (approvals: readonly HookApproval[]) => Promise<void>
  deleteByExecutor: (executorNodeId: string) => Promise<void>
}
