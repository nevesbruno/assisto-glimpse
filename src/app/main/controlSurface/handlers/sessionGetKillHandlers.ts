import { registerOperation } from '../registerOperation'
import {
  sessionGetOperation,
  sessionKillOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/session'
import type { ControlSurface } from '../controlSurface'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import type { GetNodeSessionResult, GetSessionResult } from '../../../../shared/contracts/dto'
import { createAppError } from '../../../../shared/errors/appError'
import type { PtyStreamHub } from '../ptyStream/ptyStreamHub'
import type { MultiEndpointPtyRuntime } from '../ptyStream/multiEndpointPtyRuntime'
import { assertSessionInGrant } from './agentGrantScope'
import { grantProjectOf } from './grantProjectScope'
import type { createSessionNodeResolver } from './sessionNodeResolver'
import type { SessionRecord } from './sessionRecords'

export function registerSessionGetKillHandlers(
  controlSurface: ControlSurface,
  deps: {
    getPersistenceStore(): Promise<PersistenceStore>
    ptyStreamHub: PtyStreamHub
    ptyRuntime: MultiEndpointPtyRuntime
    sessions: Map<string, SessionRecord>
    resolveNode: ReturnType<typeof createSessionNodeResolver>
  },
): void {
  const { sessions, resolveNode } = deps

  registerOperation(controlSurface, sessionGetOperation, {
    handle: async (ctx, payload): Promise<GetSessionResult | GetNodeSessionResult> => {
      if (payload.nodeId !== undefined) {
        return (await resolveNode(payload.nodeId, grantProjectOf(ctx))).value
      }
      await assertSessionInGrant(
        ctx,
        deps.getPersistenceStore,
        payload.sessionId,
        'session.not_found',
        `session.get: unknown session id: ${payload.sessionId}`,
      )
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

  registerOperation(controlSurface, sessionKillOperation, {
    handle: async (ctx, payload): Promise<void> => {
      if (payload.nodeId !== undefined) {
        const { value } = await resolveNode(payload.nodeId, grantProjectOf(ctx))
        const current = normalizePersistedAppState(
          await (await deps.getPersistenceStore()).readAppState(),
        )
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
        deps.ptyRuntime.kill(value.sessionId)
        return
      }
      await assertSessionInGrant(
        ctx,
        deps.getPersistenceStore,
        payload.sessionId,
        'session.not_found',
        `session.kill: unknown session id: ${payload.sessionId}`,
      )
      const record = sessions.get(payload.sessionId) ?? null
      if (!record && !deps.ptyStreamHub.hasSession(payload.sessionId)) {
        throw createAppError('session.not_found', {
          debugMessage: `session.kill: unknown session id: ${payload.sessionId}`,
        })
      }

      deps.ptyRuntime.kill(record?.sessionId ?? payload.sessionId)
    },
    defaultErrorCode: 'terminal.kill_failed',
  })
}
