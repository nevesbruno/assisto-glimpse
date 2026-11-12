import { randomUUID } from 'node:crypto'
import { createAppError } from '../../../../shared/errors/appError'
import { withTurnDeliveryIds } from '../../../../contexts/agent/application/turnDeliveryIds'
import type { PromptDeliveryService } from '../../../../contexts/agent/application/PromptDeliveryService'
import type { ControlSurface } from '../controlSurface'
import type { PtyStreamHub } from '../ptyStream/ptyStreamHub'
import { registerOperation } from '../registerOperation'
import {
  assertAgentNodeInGrant,
  isAgentNodeInGrant,
  type GrantStateReader,
} from './agentGrantScope'
import { grantProjectOf } from './grantProjectScope'
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
  readStore?: GrantStateReader,
): void {
  const nodeOf = (input: { nodeId: string } | { sessionId: string }) =>
    'nodeId' in input ? input.nodeId : hub.agentRuns.registry.get(input)?.nodeId
  registerOperation(surface, agentHistoryClearOperation, {
    handle: async (ctx, input) => {
      // A node outside the grant runs the real path against a throwaway id, so the reply matches a missing node.
      const target = (await isAgentNodeInGrant(ctx, readStore, input.nodeId))
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
      const target = (await isAgentNodeInGrant(ctx, readStore, nodeOf(input)))
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
      try {
        await assertAgentNodeInGrant(ctx, readStore, nodeOf(input), 'common.unexpected')
      } catch {
        return null
      }
      return hub.agentRuns.registry.get(input)
    },
    defaultErrorCode: 'common.unexpected',
  })
  registerOperation(surface, agentListOperation, {
    handle: (ctx, input) => {
      const scope = grantProjectOf(ctx)
      if (scope === undefined) {
        return hub.agentRuns.registry.list(input)
      }
      const foreign = input.projectId !== undefined && input.projectId !== scope
      const own = hub.agentRuns.registry.list({ ...input, projectId: scope })
      return foreign ? { ...own, agents: [] } : own
    },
    defaultErrorCode: 'common.unexpected',
  })
}
