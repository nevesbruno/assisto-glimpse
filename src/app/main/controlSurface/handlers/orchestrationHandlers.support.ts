import type { AgentLinkRepository } from '../../../../contexts/orchestration/application/ports'
import { DispatchRefusedError } from '../../../../contexts/orchestration/application/linkLifecycle'
import type { ExecutorHealth } from '../../../../contexts/orchestration/application/executorHealth'
import type { OrchestrationService } from '../../../../contexts/orchestration/application/OrchestrationService'
import {
  OrchestrationError,
  type AgentLink,
} from '../../../../contexts/orchestration/domain/agentLink'
import { DispatchRuleError } from '../../../../contexts/orchestration/domain/dispatch'
import {
  authorizeOrchestration,
  type OrchestrationOperation,
  type OrchestrationPrincipal,
} from '../../../../contexts/orchestration/domain/orchestrationAuthorization'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import type { AppErrorCode, OrchestrationLinkDto } from '../../../../shared/contracts/dto'
import { createAppError, OpenCoveAppError } from '../../../../shared/errors/appError'
import type { ControlSurfaceContext } from '../types'

export type OrchestrationHandlerService = Pick<
  OrchestrationService,
  | 'spawn'
  | 'dispatch'
  | 'status'
  | 'cancel'
  | 'interrupt'
  | 'close'
  | 'extendRounds'
  | 'respondApproval'
  | 'approveHooks'
  | 'createLink'
  | 'healthOf'
  | 'assertDirectInput'
>

export interface OrchestrationBackend {
  readonly service: OrchestrationHandlerService
  readonly links: Pick<
    AgentLinkRepository,
    'findById' | 'listActive' | 'listByProject' | 'readLinksRevision'
  >
}

export interface OrchestrationHandlerDeps {
  /** Null until the Worker has composed the service. */
  readonly backend: () => OrchestrationBackend | null
  /** Provider of a node in the app state at the moment of the call. */
  readonly providerOfNode: (nodeId: string) => Promise<string | null>
}

const RULE_ERROR_CODE: Record<DispatchRuleError['code'], AppErrorCode> = {
  invalid_text: 'common.invalid_input',
  invalid_transition: 'common.unexpected',
}

/** One text for every refusal of the target, so the caller cannot tell absent from foreign. */
const NOT_LINKED_MESSAGE =
  'No linked executor matches the selector. Find the executor node id with "opencove orch link list".'

/** The single place where the orchestration errors become Control Surface errors. */
export function toAppError(error: unknown): unknown {
  if (error instanceof OpenCoveAppError) {
    return error
  }
  if (error instanceof DispatchRefusedError) {
    return createAppError(error.code, { details: error.blocking ?? undefined })
  }
  if (error instanceof OrchestrationError) {
    return createAppError(
      error.code,
      error.code === 'orch.not_linked' ? { debugMessage: NOT_LINKED_MESSAGE } : {},
    )
  }
  if (error instanceof DispatchRuleError) {
    return createAppError(RULE_ERROR_CODE[error.code], { debugMessage: error.message })
  }
  return error
}

export async function mapErrors<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    throw toAppError(error)
  }
}

/** The grant was verified when the request arrived; the caller fence says whether it still is. */
function isGrantActive(ctx: ControlSurfaceContext): boolean {
  try {
    ctx.assertActive?.()
    return true
  } catch {
    return false
  }
}

/** A session grant is an agent; the provider comes from the app state, never from the grant. */
export async function principalOf(
  ctx: ControlSurfaceContext,
  providerOfNode: OrchestrationHandlerDeps['providerOfNode'],
): Promise<OrchestrationPrincipal> {
  const auth = ctx.requestAuth
  if (auth?.kind !== 'session-grant') {
    return { kind: 'user' }
  }
  const { nodeId, projectId, spaceId, sessionId } = auth.grant
  return {
    kind: 'agent',
    nodeId,
    projectId,
    spaceId,
    sessionId,
    provider: (await providerOfNode(nodeId)) ?? '',
    grantActive: isGrantActive(ctx),
  }
}

export async function assertAuthorized(
  links: OrchestrationBackend['links'],
  principal: OrchestrationPrincipal,
  operation: OrchestrationOperation,
  targetExecutorNodeId: string | null,
): Promise<void> {
  const result = authorizeOrchestration({
    principal,
    operation,
    targetExecutorNodeId,
    links: await links.listActive(),
  })
  if (!result.allowed) {
    throw new OrchestrationError(result.code)
  }
}

export function linkDtoOf(link: AgentLink, health: ExecutorHealth): OrchestrationLinkDto {
  return {
    id: link.id,
    projectId: link.projectId,
    spaceId: link.spaceId,
    orchestratorNodeId: link.orchestratorNodeId,
    executorNodeId: link.executorNodeId,
    kind: link.kind,
    origin: link.origin,
    runtimeMode: link.runtimeMode,
    provider: link.provider,
    state: link.state,
    closeReason: link.closeReason,
    health,
    roundsUsed: link.roundsUsed,
    roundsLimit: link.roundsLimit,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    revision: link.revision,
  }
}

export function createNodeProviderReader(
  getStore: () => Promise<PersistenceStore>,
): OrchestrationHandlerDeps['providerOfNode'] {
  return async nodeId => {
    const state = normalizePersistedAppState(await (await getStore()).readAppState())
    const node = state?.workspaces.flatMap(workspace => workspace.nodes).find(n => n.id === nodeId)
    const provider = (node?.agent as { provider?: unknown } | null | undefined)?.provider
    return typeof provider === 'string' ? provider : null
  }
}
