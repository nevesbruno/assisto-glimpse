import type { DirectInputOperation } from '../../../../contexts/orchestration/domain/orchestrationAuthorization'
import type { ControlSurfaceContext } from '../types'
import {
  principalOf,
  type OrchestrationBackend,
  type OrchestrationHandlerDeps,
} from './orchestrationHandlers.support'

/** Refuses with `orch.use_dispatch` an agent that writes straight into a linked executor. */
export type DirectInputGuard = (
  ctx: ControlSurfaceContext,
  operation: DirectInputOperation,
  targetNodeId: string,
) => Promise<void>

export function createDirectInputGuard(deps: {
  readonly backend: () => Pick<OrchestrationBackend, 'service'> | null
  readonly providerOfNode: OrchestrationHandlerDeps['providerOfNode']
}): DirectInputGuard {
  return async (ctx, operation, targetNodeId) => {
    const backend = deps.backend()
    if (!backend || ctx.requestAuth?.kind !== 'session-grant') {
      return
    }
    const principal = await principalOf(ctx, deps.providerOfNode)
    await backend.service.assertDirectInput(principal, operation, targetNodeId)
  }
}
