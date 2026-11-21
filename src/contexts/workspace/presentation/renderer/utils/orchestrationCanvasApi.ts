import type { ControlSurfaceInvokeRequest } from '@shared/contracts/controlSurface/request'

/** Boundary adapter for the orchestration operations the canvas calls from the renderer. */
export const invokeOrchestrationControlSurface = async (
  request: ControlSurfaceInvokeRequest,
): Promise<unknown> => await window.opencoveApi.controlSurface.invoke(request)
