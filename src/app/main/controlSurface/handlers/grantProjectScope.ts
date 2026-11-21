import { createAppError } from '../../../../shared/errors/appError'
import type { AppErrorCode } from '../../../../shared/contracts/dto'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
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

/**
 * Nodes the grant's own caller created, transitively. This is the only foreign-project authority
 * a grant has: the subtree it created. Reads and writes outside it stay confined.
 */
export async function grantLineageNodeIds(
  ctx: ControlSurfaceContext,
  readStore: (() => Promise<PersistenceStore>) | undefined,
): Promise<ReadonlySet<string>> {
  const grant = ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant : null
  if (!grant?.nodeId || !readStore) {
    return new Set()
  }
  try {
    const store = await readStore()
    if (!store.nodeLineage) {
      return new Set()
    }
    const state = normalizePersistedAppState(await store.readAppState())
    const ids = state?.workspaces.flatMap(workspace => workspace.nodes.map(node => node.id)) ?? []
    const rows = await store.nodeLineage.readMany(ids)
    const children = new Map<string, string[]>()
    for (const [nodeId, row] of rows) {
      if (!row.spawnedBy) {
        continue
      }
      const list = children.get(row.spawnedBy) ?? []
      list.push(nodeId)
      children.set(row.spawnedBy, list)
    }
    const descendants = new Set<string>()
    const queue = [...(children.get(grant.nodeId) ?? [])]
    while (queue.length > 0) {
      const nodeId = queue.shift()!
      if (descendants.has(nodeId)) {
        continue
      }
      descendants.add(nodeId)
      queue.push(...(children.get(nodeId) ?? []))
    }
    return descendants
  } catch {
    // Unreadable lineage is not authority.
    return new Set()
  }
}

export async function isNodeInGrantLineage(
  ctx: ControlSurfaceContext,
  readStore: (() => Promise<PersistenceStore>) | undefined,
  nodeId: string | null | undefined,
): Promise<boolean> {
  if (!nodeId) {
    return false
  }
  return (await grantLineageNodeIds(ctx, readStore)).has(nodeId)
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
