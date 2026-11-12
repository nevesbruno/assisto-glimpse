import { createAppError } from '../../../../shared/errors/appError'
import type { AppErrorCode } from '../../../../shared/contracts/dto'
import type { ControlSurfaceContext } from '../types'

interface ProjectScopedState {
  readonly workspaces: readonly {
    readonly id: string
    readonly nodes: readonly { readonly id: string }[]
    readonly spaces: readonly { readonly id: string }[]
  }[]
}

/** Project an agent grant is confined to. Bearer, user and IPC callers have no grant: undefined. */
export function grantProjectOf(ctx: ControlSurfaceContext): string | undefined {
  return ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant.projectId : undefined
}

/** Deny by default: with a grant, a target outside the grant project is reported as absent. */
export function assertProjectInGrant(
  ctx: ControlSurfaceContext,
  projectId: string | null | undefined,
  code: AppErrorCode,
  debugMessage?: string,
): void {
  const scope = grantProjectOf(ctx)
  if (scope !== undefined && projectId !== scope) {
    throw createAppError(code, { debugMessage })
  }
}

export function assertNodeInGrantProject(
  ctx: ControlSurfaceContext,
  state: ProjectScopedState,
  nodeId: string,
  code: AppErrorCode,
  debugMessage?: string,
): void {
  const owner = state.workspaces.find(workspace => workspace.nodes.some(node => node.id === nodeId))
  assertProjectInGrant(ctx, owner?.id, code, debugMessage)
}

export function assertSpaceInGrantProject(
  ctx: ControlSurfaceContext,
  state: ProjectScopedState,
  spaceId: string,
  code: AppErrorCode,
  debugMessage?: string,
): void {
  const owner = state.workspaces.find(workspace =>
    workspace.spaces.some(space => space.id === spaceId),
  )
  assertProjectInGrant(ctx, owner?.id, code, debugMessage)
}
