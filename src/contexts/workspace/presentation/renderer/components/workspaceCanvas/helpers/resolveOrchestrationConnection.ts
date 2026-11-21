import type { Node } from '@xyflow/react'
import type { OrchestrationLinkDto } from '@shared/contracts/dto/orchestration'
import { EXECUTOR_PROVIDERS, ORCHESTRATOR_PROVIDER } from '@contexts/orchestration/domain'
import type { TerminalNodeData } from '../../../types'
import { isAgentWorking } from '../helpers'

export type OrchestrationConnectionHintKey =
  | 'orchestration.connect.hint.sourceNotOrchestrator'
  | 'orchestration.connect.hint.sameNode'
  | 'orchestration.connect.hint.orchestratorIsExecutor'
  | 'orchestration.connect.hint.targetLinked'
  | 'orchestration.connect.hint.peerPending'
  | 'orchestration.connect.hint.crossProject'
  | 'orchestration.connect.hint.dropOnExecutor'

export type ResolveOrchestrationConnectionResult =
  | {
      readonly ok: true
      readonly kind: 'executor'
      /** The target already has a conversation; the confirmation says it is preserved. */
      readonly reattach: boolean
      /** The target is running a turn that the bootstrap may interrupt. */
      readonly busy: boolean
    }
  | { readonly ok: false; readonly reason: OrchestrationConnectionHintKey }

export interface OrchestrationConnectionNode {
  readonly nodeId: string
  readonly projectId: string
  readonly provider: string
  readonly status: TerminalNodeData['status']
  readonly resumeSessionId: string | null
}

export interface ResolveOrchestrationConnectionInput {
  readonly source: string
  readonly target: string
  readonly nodes: readonly OrchestrationConnectionNode[]
  readonly links: readonly OrchestrationLinkDto[]
}

function invalid(reason: OrchestrationConnectionHintKey): ResolveOrchestrationConnectionResult {
  return { ok: false, reason }
}

function activeLinks(links: readonly OrchestrationLinkDto[]): OrchestrationLinkDto[] {
  return links.filter(link => link.state === 'active')
}

/**
 * Matrix of section 3.2. The client is a convenience, never the authority: the Worker repeats
 * every rule on `orch.link.create`.
 */
export function resolveOrchestrationConnection(
  input: ResolveOrchestrationConnectionInput,
): ResolveOrchestrationConnectionResult {
  const nodeById = new Map(input.nodes.map(node => [node.nodeId, node]))
  const source = nodeById.get(input.source)
  const target = nodeById.get(input.target)
  if (!source || !target) {
    return invalid('orchestration.connect.hint.dropOnExecutor')
  }
  if (source.nodeId === target.nodeId) {
    return invalid('orchestration.connect.hint.sameNode')
  }
  if (source.provider !== ORCHESTRATOR_PROVIDER) {
    return invalid('orchestration.connect.hint.sourceNotOrchestrator')
  }
  if (source.projectId !== target.projectId) {
    return invalid('orchestration.connect.hint.crossProject')
  }
  const active = activeLinks(input.links)
  if (active.some(link => link.executorNodeId === source.nodeId)) {
    return invalid('orchestration.connect.hint.orchestratorIsExecutor')
  }
  if (target.provider.length === 0) {
    return invalid('orchestration.connect.hint.dropOnExecutor')
  }
  if (!EXECUTOR_PROVIDERS.includes(target.provider)) {
    // The peer conversation arrives in F3-02b2; until then claude-code never executes.
    return invalid('orchestration.connect.hint.peerPending')
  }
  if (active.some(link => link.executorNodeId === target.nodeId)) {
    return invalid('orchestration.connect.hint.targetLinked')
  }
  return {
    ok: true,
    kind: 'executor',
    reattach: target.resumeSessionId !== null,
    busy: isAgentWorking(target.status),
  }
}

/** Adapts a canvas node to the matrix input; the workspace id is the project id of its nodes. */
export function connectionNodeOf(
  node: Node<TerminalNodeData>,
  projectId: string,
): OrchestrationConnectionNode {
  const agent = node.data.agent
  return {
    nodeId: node.id,
    projectId,
    provider: agent?.provider ?? '',
    status: node.data.status,
    resumeSessionId: agent?.resumeSessionId ?? null,
  }
}

export function connectionNodesOf(
  nodes: readonly Node<TerminalNodeData>[],
  projectId: string,
): OrchestrationConnectionNode[] {
  return nodes.map(node => connectionNodeOf(node, projectId))
}
