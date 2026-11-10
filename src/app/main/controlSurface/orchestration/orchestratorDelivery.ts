import type { PromptDeliveryService } from '../../../../contexts/agent/application/PromptDeliveryService'
import type {
  OrchestratorDeliveryPort,
  OrchestratorDeliveryResult,
} from '../../../../contexts/orchestration/application/ports'
import { OpenCoveAppError } from '../../../../shared/errors/appError'

const BUSY_CODES: ReadonlySet<string> = new Set([
  'agent.busy',
  'agent.blocked',
  'agent.state_unknown',
])

export interface OrchestratorDeliveryOptions {
  readonly service: Pick<PromptDeliveryService, 'deliver'>
  readonly timeoutMs: number
}

export type OrchestratorDelivery = OrchestratorDeliveryPort & {
  inFlight: (orchestratorNodeId: string) => boolean
}

/** Only a refusal before any paste is a plain "busy"; anything after the write is uncertain. */
function resultOfFailure(error: unknown): OrchestratorDeliveryResult {
  if (!(error instanceof OpenCoveAppError) || !BUSY_CODES.has(error.code)) {
    return 'uncertain'
  }
  const details = error.details as { pasteDispatchAttempted?: boolean } | undefined
  return details?.pasteDispatchAttempted === false ? 'refused_busy' : 'uncertain'
}

/** Delivers the batch as one prompt with `whenBusy: 'refuse'`, so an occupied orchestrator gets nothing. */
export function createOrchestratorDelivery(
  options: OrchestratorDeliveryOptions,
): OrchestratorDelivery {
  const open = new Set<string>()
  return {
    inFlight: orchestratorNodeId => open.has(orchestratorNodeId),
    async deliver({ orchestratorNodeId, deliveryId, text }) {
      open.add(orchestratorNodeId)
      try {
        await options.service.deliver({
          nodeId: orchestratorNodeId,
          text,
          deliveryId,
          whenBusy: 'refuse',
          timeoutMs: options.timeoutMs,
        })
        return 'delivered'
      } catch (error) {
        return resultOfFailure(error)
      } finally {
        open.delete(orchestratorNodeId)
      }
    },
  }
}
