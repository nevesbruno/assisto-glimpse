import type { ApprovedWorkspaceStore } from '../../../../contexts/workspace/infrastructure/approval/ApprovedWorkspaceStoreCore'
import { listAgentSessions } from '../../../../contexts/agent/infrastructure/cli/AgentSessionCatalog'
import { registerOperation } from '../registerOperation'
import { agentListSessionsOperation } from '@shared/contracts/controlSurface/operations/domains/agent'
import type {
  ListAgentSessionsInput,
  ListAgentSessionsResult,
} from '../../../../shared/contracts/dto'
import { createAppError } from '../../../../shared/errors/appError'
import type { ControlSurface } from '../controlSurface'
import { relative, isAbsolute, resolve } from 'node:path'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import type { GrantStateReader } from './agentGrantScope'
import { grantProjectOf } from './grantProjectScope'

const isInside = (root: string, target: string): boolean => {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function registerAgentSessionCatalogHandlers(
  controlSurface: ControlSurface,
  deps: {
    approvedWorkspaces: ApprovedWorkspaceStore
    readStore?: GrantStateReader
  },
): void {
  registerOperation(controlSurface, agentListSessionsOperation, {
    handle: async (ctx, payload: ListAgentSessionsInput): Promise<ListAgentSessionsResult> => {
      const isApproved = await deps.approvedWorkspaces.isPathApproved(payload.cwd)
      if (!isApproved) {
        throw createAppError('common.approved_path_required', {
          debugMessage: 'agent.listSessions cwd is outside approved workspaces',
        })
      }

      const scope = grantProjectOf(ctx)
      if (scope !== undefined) {
        const state = deps.readStore
          ? normalizePersistedAppState(await (await deps.readStore()).readAppState())
          : null
        const root = state?.workspaces.find(workspace => workspace.id === scope)?.path
        const nestedForeign = state?.workspaces.some(
          workspace =>
            workspace.id !== scope &&
            root !== undefined &&
            isInside(root, workspace.path) &&
            isInside(workspace.path, payload.cwd),
        )
        if (!root || !isInside(root, payload.cwd) || nestedForeign) {
          return { provider: payload.provider, cwd: payload.cwd, sessions: [] }
        }
      }

      return await listAgentSessions(payload)
    },
    defaultErrorCode: 'common.unexpected',
  })
}
