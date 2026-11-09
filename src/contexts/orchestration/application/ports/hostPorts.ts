import type { ExecutorAttachInfo, TurnCompletionOutcome, TurnOrigin } from './executorRuntime'

export interface ExecutorNodeInfo {
  readonly nodeId: string
  readonly projectId: string
  readonly spaceId: string
  readonly provider: string
  readonly title: string
  readonly cwd: string | null
}

export interface CreateExecutorNodeInput {
  readonly orchestratorNodeId: string
  readonly provider: 'codex' | 'opencode'
  readonly title: string | null
  readonly model: string | null
}

export interface CreatedExecutorNode {
  readonly nodeId: string
  readonly spaceId: string
}

/** Creates the node beside the orchestrator and reads provider and existence of nodes. */
export interface ExecutorNodePort {
  createExecutorNode: (input: CreateExecutorNodeInput) => Promise<CreatedExecutorNode>
  findNode: (nodeId: string) => Promise<ExecutorNodeInfo | null>
}

export interface LaunchExecutorTuiInput {
  readonly executorNodeId: string
  readonly attach: ExecutorAttachInfo
}

/** Launches and relaunches the TUI in the PTY of the node, without a window grant (A5). */
export interface ExecutorTuiLauncher {
  launch: (input: LaunchExecutorTuiInput) => Promise<void>
  relaunch: (input: LaunchExecutorTuiInput) => Promise<void>
}

export type OrchestratorDeliveryResult = 'delivered' | 'refused_busy' | 'uncertain'

export interface DeliverNoticeInput {
  readonly orchestratorNodeId: string
  /** Delivery id of the whole batch. */
  readonly deliveryId: string
  readonly text: string
}

/** Delivers with `whenBusy: 'refuse'`, so an occupied orchestrator never receives the text. */
export interface OrchestratorDeliveryPort {
  deliver: (input: DeliverNoticeInput) => Promise<OrchestratorDeliveryResult>
}

export type OrchestratorBusyReason =
  | 'running'
  | 'hook_stale'
  | 'delivery_in_flight'
  | 'approval_open'
  | 'typing'

export type OrchestratorReadiness =
  | { readonly idle: true }
  | { readonly idle: false; readonly reason: OrchestratorBusyReason }

export interface OrchestratorReadinessPort {
  readReadiness: (orchestratorNodeId: string) => Promise<OrchestratorReadiness>
}

export interface TurnStartedRecord {
  readonly executorNodeId: string
  readonly turnRef: string
  readonly origin: TurnOrigin
  readonly text: string | null
}

export interface TurnCompletedRecord {
  readonly executorNodeId: string
  readonly turnRef: string
  readonly glimpseTurnId: string
  readonly outcome: TurnCompletionOutcome
  readonly finalMessage: string | null
}

/** Feeds the run state and the turns file that `agent read --turn` reads. */
export interface ExecutorRunStateIngress {
  recordTurnStarted: (record: TurnStartedRecord) => Promise<{ readonly glimpseTurnId: string }>
  recordTurnCompleted: (record: TurnCompletedRecord) => Promise<void>
  recordWaitingForApproval: (executorNodeId: string, requestId: string) => Promise<void>
  recordApprovalResolved: (executorNodeId: string, requestId: string) => Promise<void>
  recordExecutorDown: (executorNodeId: string) => Promise<void>
}

export interface PortReserver {
  reserveLoopbackPort: () => Promise<number>
}

export interface LinksUpdatedEvent {
  readonly linksRevision: number
  readonly projectIds: readonly string[]
}

export interface OrchestrationEventPublisher {
  publishLinksUpdated: (event: LinksUpdatedEvent) => void
}

export interface Clock {
  now: () => Date
}

export interface IdGenerator {
  uuid: () => string
  /** Deterministic uuid v5, used to derive the first `dispatchId` from the spawn `requestId` (L7). */
  uuidV5: (name: string) => string
}
