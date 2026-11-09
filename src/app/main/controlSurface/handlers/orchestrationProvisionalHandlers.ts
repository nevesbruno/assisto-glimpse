import {
  orchApprovalRespondOperation,
  orchCancelOperation,
  orchCloseOperation,
  orchDispatchOperation,
  orchHooksApproveOperation,
  orchInterruptOperation,
  orchLinkCloseOperation,
  orchLinkCreateOperation,
  orchLinkExtendOperation,
  orchLinkListOperation,
  orchSpawnOperation,
  orchStatusOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/orch'
import { createAppError } from '../../../../shared/errors/appError'
import { registerOperation } from '../registerOperation'
import type { ControlSurface } from '../controlSurface'

const refuse = {
  defaultErrorCode: 'common.unavailable',
  handle: (): never => {
    throw createAppError('common.unavailable')
  },
} as const

export function registerOrchestrationProvisionalHandlers(controlSurface: ControlSurface): void {
  registerOperation(controlSurface, orchSpawnOperation, refuse)
  registerOperation(controlSurface, orchDispatchOperation, refuse)
  registerOperation(controlSurface, orchStatusOperation, refuse)
  registerOperation(controlSurface, orchCancelOperation, refuse)
  registerOperation(controlSurface, orchInterruptOperation, refuse)
  registerOperation(controlSurface, orchCloseOperation, refuse)
  registerOperation(controlSurface, orchLinkCreateOperation, refuse)
  registerOperation(controlSurface, orchLinkCloseOperation, refuse)
  registerOperation(controlSurface, orchLinkListOperation, refuse)
  registerOperation(controlSurface, orchLinkExtendOperation, refuse)
  registerOperation(controlSurface, orchApprovalRespondOperation, refuse)
  registerOperation(controlSurface, orchHooksApproveOperation, refuse)
}
