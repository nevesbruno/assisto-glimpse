import { randomUUID } from 'node:crypto'
import type { ControlSurface } from '../controlSurface'
import type { PtyStreamHub } from '../ptyStream/ptyStreamHub'
import type { AgentProviderRegistry } from '../../../../contexts/agent/application/services/AgentProviderRegistry'
import { PromptDeliveryService } from '../../../../contexts/agent/application/PromptDeliveryService'
import { registerOperation } from '../registerOperation'
import type { DirectInputGuard } from './directInputGuard'
import { assertAgentNodeInGrant, type GrantStateReader } from './agentGrantScope'
import {
  agentDeliveryGetOperation,
  agentPromptOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/agent'

/** The one service of the Worker: the reservation lives in the instance, so every writer must share it. */
export function createAgentPromptDelivery(
  hub: PtyStreamHub,
  providers: Pick<AgentProviderRegistry, 'require'>,
): PromptDeliveryService {
  const service = new PromptDeliveryService({
    runs: hub.agentRuns.registry,
    input: hub,
    capability: provider => providers.require(provider).prompting,
    now: Date.now,
    createDeliveryId: randomUUID,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
  })
  hub.agentRuns.registry.onDispose(() => service.dispose())
  return service
}

export function registerAgentPromptHandlers(
  surface: ControlSurface,
  hub: PtyStreamHub,
  service: PromptDeliveryService,
  guardDirectInput: DirectInputGuard,
  readStore?: GrantStateReader,
): void {
  registerOperation(surface, agentDeliveryGetOperation, {
    handle: async (ctx, input) => {
      const delivery = service.get(input.deliveryId)
      if (delivery.available) {
        try {
          await assertAgentNodeInGrant(ctx, readStore, delivery.nodeId, 'common.unexpected')
        } catch {
          return { available: false, deliveryId: input.deliveryId, reason: 'unavailable' }
        }
      }
      return delivery
    },
    defaultErrorCode: 'common.unexpected',
  })
  registerOperation(surface, agentPromptOperation, {
    handle: async (ctx, input) => {
      const nodeId =
        input.nodeId === '@self' && ctx.requestAuth?.kind === 'session-grant'
          ? ctx.requestAuth.grant.nodeId
          : input.nodeId
      const targetNodeId =
        nodeId ?? hub.agentRuns.registry.get({ sessionId: input.sessionId! })?.nodeId
      await assertAgentNodeInGrant(ctx, readStore, targetNodeId, 'agent.not_running', {
        details: {
          reason: 'not_running',
          pasteDispatchAttempted: false,
          submitDispatchAttempted: false,
          retryable: true,
          deliveryId: input.deliveryId ?? randomUUID(),
        },
      })
      if (targetNodeId) {
        await guardDirectInput(ctx, 'agent.prompt', targetNodeId)
      }
      return service.deliver({ ...input, nodeId }, ctx)
    },
    defaultErrorCode: 'common.unexpected',
  })
}
