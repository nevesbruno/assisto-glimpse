export type ExecutorRuntimeProvider = 'codex' | 'opencode'

export type ExecutorRuntimeErrorCode =
  | 'executor.start_failed'
  | 'executor.unavailable'
  | 'executor.busy'
  | 'executor.rejected'
  | 'executor.send_uncertain'
  | 'executor.session_lost'
  | 'executor.protocol_mismatch'
  | 'executor.unsupported'

/**
 * Every operation that can fail rejects with an Error carrying one of these codes.
 * The send boundary is the write of the request to the transport: a failure before the
 * write or an error response is `executor.rejected`; any failure after the write without
 * a response is `executor.send_uncertain`.
 */
export interface ExecutorRuntimeError extends Error {
  readonly code: ExecutorRuntimeErrorCode
}

export interface ExecutorProbeResult {
  readonly executablePath: string
  readonly version: string
  readonly compatible: boolean
}

export interface ExecutorPolicy {
  readonly approvals: 'user'
  readonly sandbox: string | null
}

export interface ExecutorStartSpec {
  readonly executorNodeId: string
  /** Readable node title; names the provider thread for humans. */
  readonly title: string
  readonly provider: ExecutorRuntimeProvider
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly sessionRef: string | null
  readonly model: string | null
  readonly policy: ExecutorPolicy
}

export interface EnsureSessionInput {
  readonly resumeRef: string | null
  readonly fresh: boolean
}

export interface EnsureSessionResult {
  readonly sessionRef: string
  readonly resumed: boolean
}

export interface StartTurnInput {
  readonly dispatchId: string
  readonly text: string
}

export interface StartTurnResult {
  readonly turnRef: string
}

export type ExecutorTurnStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface ExecutorTurnUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}

export interface ExecutorTurnSnapshot {
  readonly turnRef: string
  readonly status: ExecutorTurnStatus
  readonly finalMessage: string | null
  readonly usage: ExecutorTurnUsage | null
}

export type FindTurnResult =
  | { readonly kind: 'found'; readonly turn: ExecutorTurnSnapshot }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' }

/** `cancel` denies and also interrupts the turn; `approve_for_session` covers later prompts. */
export type ApprovalDecision = 'approve' | 'approve_for_session' | 'deny' | 'cancel'

export type RespondApprovalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'approval_not_found' }

export interface ExecutorAttachInfo {
  readonly url: string
  readonly tokenEnv: { readonly name: string; readonly value: string }
  readonly sessionRef: string
  readonly cwd: string
}

export type ExecutorCloseReason = 'user' | 'link_closed' | 'node_deleted' | 'restart' | 'shutdown'

export type TurnOrigin = 'glimpse' | 'screen'
export type TurnCompletionOutcome = 'completed' | 'failed' | 'interrupted'

export interface HookTrustPending {
  readonly key: string
  readonly event: string
  readonly origin: string
  readonly currentHash: string
}

export type ExecutorRuntimeEvent =
  | {
      readonly type: 'executor.ready'
      readonly sessionRef: string
      readonly resumed: boolean
      readonly version: string
    }
  | {
      readonly type: 'turn.started'
      readonly turnRef: string
      readonly dispatchId: string | null
      readonly origin: TurnOrigin
    }
  | {
      readonly type: 'turn.completed'
      readonly turnRef: string
      readonly dispatchId: string | null
      readonly outcome: TurnCompletionOutcome
      readonly finalMessage: string | null
      readonly usage: ExecutorTurnUsage | null
    }
  | {
      readonly type: 'approval.requested'
      readonly requestId: string
      readonly kind: string
      readonly summary: string
      readonly turnRef: string | null
    }
  | {
      readonly type: 'approval.resolved'
      readonly requestId: string
      readonly resolvedBy: 'screen' | 'glimpse'
    }
  | { readonly type: 'hooks.trust_pending'; readonly hooks: readonly HookTrustPending[] }
  | { readonly type: 'executor.degraded'; readonly reason: string }
  | {
      readonly type: 'executor.down'
      readonly reason: string
      readonly exitCode: number | null
      readonly signal: string | null
    }
  | { readonly type: 'executor.recovered'; readonly sessionRef: string }

export type ExecutorRuntimeListener = (event: ExecutorRuntimeEvent) => void
export type Unsubscribe = () => void

export interface ExecutorServiceIdentity {
  readonly pid: number
  /** SHA-256 hex of the service token. The plain token never leaves the owning process. */
  readonly tokenSha256: string
}

export interface ExecutorRuntime {
  ensureSession: (input: EnsureSessionInput) => Promise<EnsureSessionResult>
  /** Expects a dispatch already persisted as `reserved`. One transport write per call, never repeated. */
  startTurn: (input: StartTurnInput) => Promise<StartTurnResult>
  /** Read only. `since` is the reservation time of the dispatch. */
  findTurnByDispatch: (dispatchId: string, since: Date) => Promise<FindTurnResult>
  /** Read only. */
  readTurn: (turnRef: string) => Promise<ExecutorTurnSnapshot>
  /** Idempotent by `requestId`. */
  respondApproval: (requestId: string, decision: ApprovalDecision) => Promise<RespondApprovalResult>
  /** No effect on an idle executor. */
  interrupt: (turnRef?: string) => Promise<void>
  attachInfo: () => Promise<ExecutorAttachInfo>
  /** Read only. Null without a live service or with an invalid pid (1 or less). */
  serviceIdentity: () => Promise<ExecutorServiceIdentity | null>
  /** Events arrive in order per executor. */
  subscribe: (listener: ExecutorRuntimeListener) => Unsubscribe
  /** SIGTERM, wait 3 s, then SIGKILL. */
  close: (reason: ExecutorCloseReason) => Promise<void>
}

export interface ExecutorRuntimeFactory {
  /** No side effects. */
  probe: () => Promise<ExecutorProbeResult>
  /** Spawns the process and waits for readiness. */
  start: (spec: ExecutorStartSpec) => Promise<ExecutorRuntime>
}
