import { randomUUID } from 'node:crypto'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import { projectNodeLineages } from '../../../../contexts/workspace/application/nodeLineage/NodeLineageOwner'
import { createAppError } from '../../../../shared/errors/appError'
import { withTurnDeliveryIds } from '../../../../contexts/agent/application/turnDeliveryIds'
import type { PromptDeliveryService } from '../../../../contexts/agent/application/PromptDeliveryService'
import type { ControlSurface } from '../controlSurface'
import type { PtyStreamHub } from '../ptyStream/ptyStreamHub'
import { registerOperation } from '../registerOperation'
import { assertAgentNodeInGrant, isAgentNodeInGrant } from './agentGrantScope'
import { grantProjectOf, isNodeInGrantLineage, isNodeInGrantSubtree } from './grantProjectScope'
import {
  agentHistoryClearOperation,
  agentGetOperation,
  agentFinalMessageOperation,
  agentListOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/agent'
export function registerAgentRunStateHandlers(
  surface: ControlSurface,
  hub: PtyStreamHub,
  deliveries?: Pick<PromptDeliveryService, 'forTurn'>,
  getPersistenceStore?: () => Promise<PersistenceStore>,
): void {
  const nodeOf = (input: { nodeId: string } | { sessionId: string }) =>
    'nodeId' in input ? input.nodeId : hub.agentRuns.registry.get(input)?.nodeId
  registerOperation(surface, agentHistoryClearOperation, {
    handle: async (ctx, input) => {
      // A node outside the grant runs the real path against a throwaway id, so the reply matches a missing node.
      const target = (await isAgentNodeInGrant(ctx, getPersistenceStore, input.nodeId))
        ? input.nodeId
        : randomUUID()
      const { remote, ...cleared } = hub.agentRuns.registry.clearHistory(target)
      const result = { ...cleared, nodeId: input.nodeId }
      if (remote) {
        throw createAppError('common.unavailable', {
          details: { reason: 'remote_history_unavailable', ...result },
        })
      }
      if (result.archive.status === 'unavailable') {
        throw createAppError('common.unavailable', {
          details: { reason: 'archive_unavailable', ...result },
        })
      }
      return result
    },
    defaultErrorCode: 'common.unavailable',
  })
  registerOperation(surface, agentFinalMessageOperation, {
    handle: async (ctx, input) => {
      const target = (await isAgentNodeInGrant(ctx, getPersistenceStore, nodeOf(input)))
        ? input
        : 'nodeId' in input
          ? { ...input, nodeId: randomUUID() }
          : { ...input, sessionId: randomUUID() }
      return withTurnDeliveryIds(() => hub.agentRuns.registry.finalMessage(target), deliveries)
    },
    defaultErrorCode: 'agent.final_message_unavailable',
  })
  registerOperation(surface, agentGetOperation, {
    handle: async (ctx, input) => {
      const target = nodeOf(input)
      try {
        await assertAgentNodeInGrant(ctx, getPersistenceStore, target, 'common.unexpected')
      } catch {
        // Foreign project: only the grant's own lineage subtree is visible.
        if (!(await isNodeInGrantLineage(ctx, getPersistenceStore, target))) {
          return null
        }
      }
      return hub.agentRuns.registry.get(input)
    },
    defaultErrorCode: 'common.unexpected',
  })
  registerOperation(surface, agentListOperation, {
    handle: async (ctx, input) => {
      const scope = grantProjectOf(ctx)
      const foreign =
        scope !== undefined && input.projectId !== undefined && input.projectId !== scope
      const result = hub.agentRuns.registry.list(
        scope === undefined || foreign ? input : { ...input, projectId: scope },
      )
      if (foreign) {
        // Narrow lineage carve-out: own creator, requested project, children only.
        const empty = { ...result, agents: [] }
        if (!input.spawnedByNodeId) {
          return empty
        }
        if (!(await isNodeInGrantSubtree(ctx, getPersistenceStore, input.spawnedByNodeId))) {
          return empty
        }
      }
      if (!input.spawnedByNodeId) {
        return result
      }
      if (!getPersistenceStore) {
        throw createAppError('persistence.unavailable')
      }
      const store = await getPersistenceStore()
      if (!store.nodeLineage) {
        throw createAppError('persistence.unavailable')
      }
      const candidates = result.agents.filter(a => a.nodeId !== null).map(a => ({ id: a.nodeId! }))
      const selected = await projectNodeLineages(store, candidates, input.spawnedByNodeId)
      const lineageById = new Map(selected.map(node => [node.id, node] as const))
      // Carry the projection: the CLI resolves lineage through node.get, which stays confined
      // to the grant project and cannot describe a child in the requested foreign project.
      return {
        ...result,
        agents: result.agents
          .filter(a => a.nodeId && lineageById.has(a.nodeId))
          .map(a => {
            const lineage = lineageById.get(a.nodeId!)!
            return {
              ...a,
              spawnedBy: lineage.spawnedBy,
              lineageDepth: lineage.lineageDepth,
              lineageStatus: lineage.lineageStatus,
            }
          }),
      }
    },
    defaultErrorCode: 'common.unexpected',
  })
}
