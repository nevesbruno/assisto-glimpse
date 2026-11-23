import type { NodeControlAppState } from './nodeControlState'

/**
 * Restricts the state a node operation can see to one project. A project outside the scope is
 * indistinguishable from an absent one. Callers that persist must keep the unscoped state.
 */
export function scopeNodeControlState(
  state: NodeControlAppState,
  projectScope?: string,
): NodeControlAppState {
  if (projectScope === undefined) {
    return state
  }
  return {
    ...state,
    activeWorkspaceId: projectScope,
    workspaces: state.workspaces.filter(workspace => workspace.id === projectScope),
  }
}
