import type {
  CanvasFocusEventTarget,
  CanvasFocusTargetInput,
} from '../../../../shared/contracts/dto'
import { createAppError } from '../../../../shared/errors/appError'
import { requireNodeControlState, type NodeControlAppStateStore } from './nodeControlState'
import { findNodeForNodeControl } from './nodeDtos'
import { scopeNodeControlState } from './nodeProjectScope'
import { resolveSpaceLocatorForNodeControl, type SpaceLocatorResolverDeps } from './spaceLocator'

export async function resolveCanvasFocusTargetForNodeControl(options: {
  store: NodeControlAppStateStore
  locatorDeps: SpaceLocatorResolverDeps
  target: CanvasFocusTargetInput
  projectScope?: string
}): Promise<{ projectId: string; target: CanvasFocusEventTarget }> {
  const state = scopeNodeControlState(
    requireNodeControlState(await options.store.readAppState()),
    options.projectScope,
  )

  if (options.target.kind === 'node') {
    const matched = findNodeForNodeControl(state.workspaces, options.target.nodeId)
    if (!matched) {
      throw createAppError('node.not_found')
    }

    return {
      projectId: matched.workspace.id,
      target: { kind: 'node', nodeId: matched.node.id, spaceId: matched.spaceId },
    }
  }

  const resolved = await resolveSpaceLocatorForNodeControl(
    state,
    options.locatorDeps,
    options.target.locator,
  )
  return {
    projectId: resolved.workspace.id,
    target: { kind: 'space', spaceId: resolved.space.id },
  }
}
