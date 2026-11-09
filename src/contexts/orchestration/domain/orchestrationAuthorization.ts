import {
  isActiveLink,
  ORCHESTRATOR_PROVIDER,
  type AgentLink,
  type OrchestrationErrorCode,
} from './agentLink'

export type OrchestrationOperation =
  | 'orch.spawn'
  | 'orch.dispatch'
  | 'orch.status'
  | 'orch.cancel'
  | 'orch.interrupt'
  | 'orch.close'
  | 'orch.link.list'
  | 'orch.link.create'
  | 'orch.link.close'
  | 'orch.link.extend'
  | 'orch.approval.respond'
  | 'orch.hooks.approve'

export type DirectInputOperation = 'agent.prompt' | 'session.writeNode'

export interface UserPrincipal {
  readonly kind: 'user'
}

export interface AgentPrincipal {
  readonly kind: 'agent'
  readonly nodeId: string
  readonly projectId: string
  readonly spaceId: string
  readonly sessionId: string
  readonly provider: string
  readonly grantActive: boolean
}

export type OrchestrationPrincipal = UserPrincipal | AgentPrincipal

export type AuthorizationResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly code: Extract<
        OrchestrationErrorCode,
        'orch.forbidden' | 'orch.not_linked' | 'orch.use_dispatch'
      >
    }

const ALLOWED: AuthorizationResult = { allowed: true }
const FORBIDDEN: AuthorizationResult = { allowed: false, code: 'orch.forbidden' }
const NOT_LINKED: AuthorizationResult = { allowed: false, code: 'orch.not_linked' }
const USE_DISPATCH: AuthorizationResult = { allowed: false, code: 'orch.use_dispatch' }

const TARGETED_OPERATIONS: readonly OrchestrationOperation[] = [
  'orch.dispatch',
  'orch.cancel',
  'orch.interrupt',
  'orch.close',
  'orch.status',
]

const READ_OPERATIONS: readonly OrchestrationOperation[] = ['orch.status', 'orch.link.list']

function isExecutorOfActiveLink(agent: AgentPrincipal, links: readonly AgentLink[]): boolean {
  return links.some(link => isActiveLink(link) && link.executorNodeId === agent.nodeId)
}

function isOrchestrator(agent: AgentPrincipal): boolean {
  return agent.grantActive && agent.provider === ORCHESTRATOR_PROVIDER
}

function ownsActiveLinkTo(
  agent: AgentPrincipal,
  executorNodeId: string,
  links: readonly AgentLink[],
): boolean {
  return links.some(
    link =>
      isActiveLink(link) &&
      link.executorNodeId === executorNodeId &&
      link.orchestratorNodeId === agent.nodeId &&
      link.projectId === agent.projectId,
  )
}

export interface AuthorizeOrchestrationInput {
  readonly principal: OrchestrationPrincipal
  readonly operation: OrchestrationOperation
  readonly targetExecutorNodeId: string | null
  readonly links: readonly AgentLink[]
}

export function authorizeOrchestration(input: AuthorizeOrchestrationInput): AuthorizationResult {
  const { principal, operation, targetExecutorNodeId, links } = input
  if (principal.kind === 'user') {
    return ALLOWED
  }
  if (!principal.grantActive || isExecutorOfActiveLink(principal, links)) {
    return FORBIDDEN
  }
  if (READ_OPERATIONS.includes(operation) && targetExecutorNodeId === null) {
    return ALLOWED
  }
  if (!isOrchestrator(principal)) {
    return FORBIDDEN
  }
  if (operation === 'orch.spawn') {
    return ALLOWED
  }
  if (!TARGETED_OPERATIONS.includes(operation)) {
    return FORBIDDEN
  }
  if (targetExecutorNodeId === null) {
    return NOT_LINKED
  }
  return ownsActiveLinkTo(principal, targetExecutorNodeId, links) ? ALLOWED : NOT_LINKED
}

export function visibleLinks(
  principal: OrchestrationPrincipal,
  links: readonly AgentLink[],
): readonly AgentLink[] {
  if (principal.kind === 'user') {
    return links
  }
  if (!isOrchestrator(principal) || isExecutorOfActiveLink(principal, links)) {
    return []
  }
  return links.filter(link => ownsActiveLinkTo(principal, link.executorNodeId, [link]))
}

export interface AuthorizeDirectInputInput {
  readonly principal: OrchestrationPrincipal
  readonly operation: DirectInputOperation
  readonly targetNodeId: string
  readonly links: readonly AgentLink[]
}

export function authorizeDirectInput(input: AuthorizeDirectInputInput): AuthorizationResult {
  const { principal, targetNodeId, links } = input
  if (principal.kind === 'user') {
    return ALLOWED
  }
  const targetsLinkedExecutor = links.some(
    link => isActiveLink(link) && link.executorNodeId === targetNodeId,
  )
  return targetsLinkedExecutor ? USE_DISPATCH : ALLOWED
}
