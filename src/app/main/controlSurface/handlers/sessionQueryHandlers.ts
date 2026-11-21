import { assertManagedClaudeStopAllowed } from '../managedClaudeCompatibility'
import type { ControlSurface } from '../controlSurface'
import type { registerSessionHandlers } from './sessionHandlers'
import type { createSessionNodeResolver } from './sessionNodeResolver'
import type { SessionRecord } from './sessionRecords'
import type { GetSessionResult, GetNodeSessionResult } from '../../../../shared/contracts/dto'
import { registerOperation } from '../registerOperation'
import {
  sessionGetOperation,
  sessionKillOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/session'
import { createAppError } from '../../../../shared/errors/appError'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import { registerSessionFinalMessageHandler } from './sessionFinalMessageHandler'
import { assertSessionInGrant } from './agentGrantScope'
import { grantProjectOf } from './grantProjectScope'
import { relative, resolve, isAbsolute } from 'node:path'

/** A freshly launched session has no persisted node yet; its launch record carries the project. */
function isInsideProjectRoot(cwd: string, root: string): boolean {
  const from = resolve(root)
  const to = resolve(cwd)
  const rel = relative(from, to)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) ? true : to === from
}

async function launchedInScope(
  sessions: Map<string, SessionRecord>,
  sessionId: string,
  scope: string | undefined,
  readStore: () => Promise<{ readAppState(): Promise<unknown> }>,
): Promise<boolean> {
  if (scope === undefined) {
    return false
  }
  const record = sessions.get(sessionId)
  if (!record) {
    return false
  }
  if (record.grantProjectId === scope || record.executionContext?.projectId === scope) {
    return true
  }
  if (typeof record.cwd !== 'string' || record.cwd.length === 0) {
    return false
  }
  const state = normalizePersistedAppState(await (await readStore()).readAppState())
  const project = state?.workspaces.find(workspace => workspace.id === scope)
  return project !== undefined && isInsideProjectRoot(record.cwd, project.path)
}

export function registerSessionQueryHandlers(
  controlSurface: ControlSurface,
  deps: Parameters<typeof registerSessionHandlers>[1],
  sessions: Map<string, SessionRecord>,
  resolveNode: ReturnType<typeof createSessionNodeResolver>,
): void {
  registerOperation(controlSurface, sessionGetOperation, {
    handle: async (ctx, payload): Promise<GetSessionResult | GetNodeSessionResult> => {
      if (payload.nodeId !== undefined) {
        return (await resolveNode(payload.nodeId, grantProjectOf(ctx))).value
      }
      if (
        !(await launchedInScope(
          sessions,
          payload.sessionId,
          grantProjectOf(ctx),
          deps.getPersistenceStore,
        ))
      ) {
        await assertSessionInGrant(
          ctx,
          deps.getPersistenceStore,
          payload.sessionId,
          'session.not_found',
          `session.get: unknown session id: ${payload.sessionId}`,
        )
      }
      const record = sessions.get(payload.sessionId)
      if (!record) {
        throw createAppError('session.not_found', {
          debugMessage: `session.get: unknown session id: ${payload.sessionId}`,
        })
      }

      const { startedAtMs: _startedAtMs, route: _route, ...publicRecord } = record
      return publicRecord
    },
    defaultErrorCode: 'common.unexpected',
  })

  registerSessionFinalMessageHandler(controlSurface, {
    sessions,
    topology: deps.topology,
    getPersistenceStore: deps.getPersistenceStore,
    resolveNode,
  })

  registerOperation(controlSurface, sessionKillOperation, {
    handle: async (ctx, payload): Promise<void> => {
      if (payload.nodeId !== undefined) {
        const store = await deps.getPersistenceStore()
        const { value } = await resolveNode(payload.nodeId, grantProjectOf(ctx))
        const current = normalizePersistedAppState(await store.readAppState())
        const stillBound = current?.workspaces.some(workspace =>
          workspace.nodes.some(
            node => node.id === payload.nodeId && node.sessionId === value.sessionId,
          ),
        )
        if (!stillBound) {
          throw createAppError('common.invalid_input', {
            debugMessage: 'Node session changed before kill; read it again.',
          })
        }
        if (!deps.ptyStreamHub.hasSession(value.sessionId)) {
          throw createAppError('session.not_found')
        }
        ctx.assertActive?.()
        assertManagedClaudeStopAllowed(ctx, store, value.sessionId, payload.nodeId)
        deps.ptyRuntime.kill(value.sessionId)
        return
      }
      if (
        !(await launchedInScope(
          sessions,
          payload.sessionId,
          grantProjectOf(ctx),
          deps.getPersistenceStore,
        ))
      ) {
        await assertSessionInGrant(
          ctx,
          deps.getPersistenceStore,
          payload.sessionId,
          'session.not_found',
          `session.kill: unknown session id: ${payload.sessionId}`,
        )
      }
      const record = sessions.get(payload.sessionId) ?? null
      if (!record && !deps.ptyStreamHub.hasSession(payload.sessionId)) {
        throw createAppError('session.not_found', {
          debugMessage: `session.kill: unknown session id: ${payload.sessionId}`,
        })
      }

      const store = await deps.getPersistenceStore()
      ctx.assertActive?.()
      assertManagedClaudeStopAllowed(ctx, store, record?.sessionId ?? payload.sessionId)
      deps.ptyRuntime.kill(record?.sessionId ?? payload.sessionId)
    },
    defaultErrorCode: 'terminal.kill_failed',
  })
}
