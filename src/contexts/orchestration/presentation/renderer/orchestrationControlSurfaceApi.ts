import type { ControlSurfaceInvokeRequest } from '@shared/contracts/controlSurface/request'

export type InvokeOrchestrationControlSurface = (
  request: ControlSurfaceInvokeRequest,
) => Promise<unknown>

/** Boundary adapter for the orchestration operations the canvas calls from the renderer. */
export const invokeOrchestrationControlSurface: InvokeOrchestrationControlSurface = async request =>
  await window.opencoveApi.controlSurface.invoke(request)
