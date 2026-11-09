export type OrchestrationErrorCode =
  | 'orch.forbidden'
  | 'orch.not_linked'
  | 'orch.link_invalid'
  | 'orch.executor_unavailable'
  | 'orch.round_limit_reached'
  | 'orch.dispatch_conflict'
  | 'orch.dispatch_in_flight'
  | 'orch.limit_reached'
  | 'orch.protocol_mismatch'
  | 'orch.approval_not_found'
  | 'orch.use_dispatch'
  | 'orch.link_declined'
  | 'orch.message_limit_reached'

export class OrchestrationError extends Error {
  public constructor(
    public readonly code: OrchestrationErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'OrchestrationError'
  }
}

export type AgentLinkKind = 'executor' | 'peer'
export type AgentLinkOrigin = 'orchestrator_spawn' | 'conversation_request' | 'canvas_manual'
export type AgentLinkRuntimeMode = 'service' | 'terminal'
export type AgentLinkState = 'requested' | 'active' | 'closed'
export type AgentLinkCloseReason =
  | 'orchestrator'
  | 'user'
  | 'node_deleted'
  | 'spawn_failed'
  | 'declined'

export const ORCHESTRATOR_PROVIDER = 'claude-code'
export const EXECUTOR_PROVIDERS: readonly string[] = ['codex', 'opencode']
export const DEFAULT_ROUNDS_LIMIT = 3
export const DEFAULT_MESSAGES_LIMIT = 5

export interface AgentLink {
  readonly id: string
  readonly projectId: string
  readonly spaceId: string
  readonly orchestratorNodeId: string
  readonly executorNodeId: string
  readonly kind: AgentLinkKind
  readonly origin: AgentLinkOrigin
  readonly runtimeMode: AgentLinkRuntimeMode
  readonly provider: string
  readonly state: AgentLinkState
  readonly closeReason: AgentLinkCloseReason | null
  readonly requestReason: string | null
  readonly requestedAt: string | null
  readonly messagesLimit: number
  readonly messagesUsedSource: number
  readonly messagesUsedTarget: number
  readonly spawnRequestId: string | null
  readonly executorSessionRef: string | null
  readonly servicePid: number | null
  readonly serviceTokenSha256: string | null
  readonly roundsUsed: number
  readonly roundsLimit: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly closedAt: string | null
  readonly revision: number
}

export interface LinkNodeRef {
  readonly nodeId: string
  readonly projectId: string
  readonly provider: string
}

export interface CreateExecutorLinkInput {
  readonly id: string
  readonly spaceId: string
  readonly orchestrator: LinkNodeRef
  readonly executor: LinkNodeRef
  readonly spawnRequestId: string | null
  readonly existingLinks: readonly AgentLink[]
  readonly now: Date
}

function invalid(message: string): never {
  throw new OrchestrationError('orch.link_invalid', message)
}

export function isActiveLink(link: AgentLink): boolean {
  return link.state === 'active'
}

export function createExecutorLink(input: CreateExecutorLinkInput): AgentLink {
  const { orchestrator, executor, existingLinks } = input
  const active = existingLinks.filter(isActiveLink)

  if (orchestrator.provider !== ORCHESTRATOR_PROVIDER) {
    invalid('orchestrator must be a claude-code agent')
  }
  if (!EXECUTOR_PROVIDERS.includes(executor.provider)) {
    invalid('executor must be a codex or opencode agent')
  }
  if (orchestrator.nodeId === executor.nodeId) {
    invalid('orchestrator and executor must be different nodes')
  }
  if (orchestrator.projectId !== executor.projectId) {
    invalid('link never crosses projects')
  }
  if (active.some(link => link.executorNodeId === executor.nodeId)) {
    invalid('executor already has an active link')
  }
  if (active.some(link => link.executorNodeId === orchestrator.nodeId)) {
    invalid('an executor never dispatches')
  }

  const now = input.now.toISOString()
  return {
    id: input.id,
    projectId: orchestrator.projectId,
    spaceId: input.spaceId,
    orchestratorNodeId: orchestrator.nodeId,
    executorNodeId: executor.nodeId,
    kind: 'executor',
    origin: 'orchestrator_spawn',
    runtimeMode: 'service',
    provider: executor.provider,
    state: 'active',
    closeReason: null,
    requestReason: null,
    requestedAt: null,
    messagesLimit: DEFAULT_MESSAGES_LIMIT,
    messagesUsedSource: 0,
    messagesUsedTarget: 0,
    spawnRequestId: input.spawnRequestId,
    executorSessionRef: null,
    servicePid: null,
    serviceTokenSha256: null,
    roundsUsed: 0,
    roundsLimit: DEFAULT_ROUNDS_LIMIT,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    revision: 1,
  }
}

export function closeLink(link: AgentLink, reason: AgentLinkCloseReason, now: Date): AgentLink {
  if (link.state === 'closed') {
    invalid('closed link is final')
  }
  const iso = now.toISOString()
  return {
    ...link,
    state: 'closed',
    closeReason: reason,
    closedAt: iso,
    updatedAt: iso,
    revision: link.revision + 1,
  }
}
