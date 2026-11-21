import { orchApprovalListOperation } from '../../../../shared/contracts/controlSurface/operations/domains/orchAttention'
import { createAppError } from '../../../../shared/errors/appError'
import type { ControlSurface } from '../controlSurface'
import { registerOperation } from '../registerOperation'
import {
  mapErrors,
  principalOf,
  type OrchestrationHandlerDeps,
} from './orchestrationHandlers.support'

/** The attention read lives apart from `orch.*` operations so their contract stays untouched. */
export function registerOrchestrationAttentionHandlers(
  controlSurface: ControlSurface,
  deps: OrchestrationHandlerDeps,
): void {
  registerOperation(controlSurface, orchApprovalListOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: (ctx, input) =>
      mapErrors(async () => {
        const backend = deps.backend()
        if (!backend) {
          throw createAppError('common.unavailable')
        }
        return backend.service.pendingAttention(await principalOf(ctx, deps.providerOfNode), input)
      }),
  })
}
