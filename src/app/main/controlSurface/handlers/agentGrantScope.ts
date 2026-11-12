import { createAppError } from '../../../../shared/errors/appError'
import type { AppErrorCode } from '../../../../shared/contracts/dto'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import type { ControlSurfaceContext } from '../types'
import { grantProjectOf } from './grantProjectScope'

export type GrantStateReader = () => Promise<PersistenceStore>
type DenyOptions = Parameters<typeof createAppError>[1]

/** Agent without a resolvable node, or without a state reader, is invisible to a grant. */
export async function isAgentNodeInGrant(
  ctx: ControlSurfaceContext,
  readStore: GrantStateReader | undefined,
  nodeId: string | null | undefined,
): Promise<boolean> {
  const scope = grantProjectOf(ctx)
  if (scope === undefined) {
    return true
  }
  const state =
    nodeId && readStore
      ? normalizePersistedAppState(await (await readStore()).readAppState())
      : null
  const owner = state?.workspaces.find(workspace => workspace.nodes.some(n => n.id === nodeId))
  return owner?.id === scope
}

export async function assertAgentNodeInGrant(
  ctx: ControlSurfaceContext,
  readStore: GrantStateReader | undefined,
  nodeId: string | null | undefined,
  code: AppErrorCode,
  options?: DenyOptions,
): Promise<void> {
  if (!(await isAgentNodeInGrant(ctx, readStore, nodeId))) {
    throw createAppError(code, options)
  }
}

/** Owning project of a persisted session, resolved through the node that holds it. */
export async function isSessionInGrant(
  ctx: ControlSurfaceContext,
  readStore: GrantStateReader | undefined,
  sessionId: string,
): Promise<boolean> {
  const scope = grantProjectOf(ctx)
  if (scope === undefined) {
    return true
  }
  const state = readStore
    ? normalizePersistedAppState(await (await readStore()).readAppState())
    : null
  const owner = state?.workspaces.find(workspace =>
    workspace.nodes.some(node => node.sessionId === sessionId),
  )
  return owner?.id === scope
}

export async function assertSessionInGrant(
  ctx: ControlSurfaceContext,
  readStore: GrantStateReader | undefined,
  sessionId: string,
  code: AppErrorCode,
  debugMessage?: string,
): Promise<void> {
  if (!(await isSessionInGrant(ctx, readStore, sessionId))) {
    throw createAppError(code, { debugMessage })
  }
}
