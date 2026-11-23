import { createAppError } from '../../../../shared/errors/appError'
import { assertSessionGrantMessagePrompt } from '../http/sessionGrantPromptPolicy'
import { randomUUID } from 'node:crypto'
import type { ControlSurface } from '../controlSurface'
import type { PtyStreamHub } from '../ptyStream/ptyStreamHub'
import type { AgentProviderRegistry } from '../../../../contexts/agent/application/services/AgentProviderRegistry'
import { PromptDeliveryService } from '../../../../contexts/agent/application/PromptDeliveryService'
import { registerOperation } from '../registerOperation'
import type { DirectInputGuard } from './directInputGuard'
import { assertAgentNodeInGrant, type GrantStateReader } from './agentGrantScope'
import { grantProjectOf } from './grantProjectScope'
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

/**
 * The Worker composes one `PromptDeliveryService` and passes it here, so the reservation the
 * notice pump uses is the same one `agent.prompt` uses. Accepting the registry keeps the
 * upstream call shape: the service is then created here and returned.
 */
export function registerAgentPromptHandlers(
  surface: ControlSurface,
  hub: PtyStreamHub,
  deliverySource: PromptDeliveryService | Pick<AgentProviderRegistry, 'require'>,
  guardDirectInput: DirectInputGuard = async () => undefined,
  readStore?: GrantStateReader,
): PromptDeliveryService {
  const service =
    'require' in deliverySource ? createAgentPromptDelivery(hub, deliverySource) : deliverySource
  registerOperation(surface, agentDeliveryGetOperation, {
    handle: async (ctx, input) => {
      const delivery = service.get(input.deliveryId)
      if (delivery.available) {
        const scope = grantProjectOf(ctx)
        const trustedByRegistry =
          scope !== undefined &&
          delivery.nodeId !== null &&
          hub.agentRuns.registry.projectOf?.({ nodeId: delivery.nodeId }) === scope
        if (!trustedByRegistry) {
          try {
            await assertAgentNodeInGrant(ctx, readStore, delivery.nodeId, 'common.unexpected')
          } catch {
            return { available: false, deliveryId: input.deliveryId, reason: 'unavailable' }
          }
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
      if (nodeId === null) {
        throw createAppError('common.invalid_input', {
          details: {
            issues: [
              {
                path: ['nodeId'],
                message: 'This session is not bound to a canvas node.',
                hint: 'Choose an explicit nodeId; with agent prompt, use --node <selector>.',
              },
            ],
          },
        })
      }
      // Provider command prefixes are refused before any state lookup, as upstream orders it.
      if (ctx.requestAuth?.kind === 'session-grant') {
        const fence = hub.agentRuns.registry.readFence?.(
          nodeId ? { nodeId } : { sessionId: input.sessionId! },
        )
        if (fence) {
          assertSessionGrantMessagePrompt(input.text, {
            provider: fence.snapshot.provider,
            operationId: 'agent.prompt',
            field: 'text',
          })
        }
      }
      if (nodeId === null) {
        throw createAppError('common.invalid_input', {
          details: {
            issues: [
              {
                path: ['nodeId'],
                message: 'This session is not bound to a canvas node.',
                hint: 'Choose an explicit nodeId; with agent prompt, use --node <selector>.',
              },
            ],
          },
        })
      }
      const targetNodeId =
        nodeId ?? hub.agentRuns.registry.get({ sessionId: input.sessionId! })?.nodeId ?? null
      const scope = grantProjectOf(ctx)
      const trustedByRegistry =
        scope !== undefined &&
        targetNodeId !== null &&
        hub.agentRuns.registry.projectOf?.({ nodeId: targetNodeId }) === scope
      if (!trustedByRegistry) {
        await assertAgentNodeInGrant(ctx, readStore, targetNodeId, 'agent.not_running', {
          details: {
            reason: 'not_running',
            pasteDispatchAttempted: false,
            submitDispatchAttempted: false,
            retryable: true,
            deliveryId: input.deliveryId ?? randomUUID(),
          },
        })
      }
      if (targetNodeId) {
        await guardDirectInput(ctx, 'agent.prompt', targetNodeId)
      }
      return service.deliver(
        {
          ...input,
          nodeId,
        },
        {
          ...ctx,
          authorizePrompt:
            ctx.requestAuth?.kind === 'session-grant'
              ? (provider, text) =>
                  assertSessionGrantMessagePrompt(text, {
                    provider,
                    operationId: 'agent.prompt',
                    field: 'text',
                  })
              : undefined,
        },
      )
    },
    defaultErrorCode: 'common.unexpected',
  })
  return service
}
