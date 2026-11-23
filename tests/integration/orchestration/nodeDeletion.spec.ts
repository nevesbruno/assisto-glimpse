// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerSyncHandlers } from '../../../src/app/main/controlSurface/handlers/syncHandlers'
import { SessionGrantRegistry } from '../../../src/app/main/controlSurface/http/sessionGrantRegistry'
import {
  createStatePersistedHook,
  notifyAfterStateWrite,
} from '../../../src/app/main/controlSurface/orchestration/nodeDeletionTrigger'
import { createOrchestrationLinksMirror } from '../../../src/app/main/controlSurface/orchestration/orchestrationLinksMirror'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { OrchestrationError } from '../../../src/contexts/orchestration/domain/agentLink'
import {
  orchestratorPrincipal,
  spawnedHarness,
} from '../../unit/contexts/orchestration/application/fakes'

function fakeStore(result: { ok: boolean }) {
  const writeAppState = vi.fn(async () => (result.ok ? { ok: true, revision: 1 } : result))
  const store = {
    readAppStateRevision: async () => 0,
    writeAppState,
  } as unknown as PersistenceStore
  return { store, writeAppState }
}

const user = { now: () => new Date(), capabilities: {} } as unknown as ControlSurfaceContext

describe('I-07 node deletion triggers', () => {
  it('sync.writeState runs the reconciler after the state is persisted', async () => {
    const { store } = fakeStore({ ok: true })
    const reconcile = vi.fn(async () => undefined)
    const base = vi.fn(async () => undefined)
    const surface = createControlSurface()
    registerSyncHandlers(surface, async () => store, {
      onStatePersisted: createStatePersistedHook(base, reconcile),
    })

    await surface.invoke(user, {
      kind: 'command',
      id: 'sync.writeState',
      payload: { state: {}, baseRevision: 0 },
    })

    expect(base).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('node.delete persists through writeAppState and reaches the reconciler', async () => {
    const { store } = fakeStore({ ok: true })
    const reconcile = vi.fn(async () => undefined)
    const wrapped = await notifyAfterStateWrite(async () => store, reconcile)()

    await wrapped.writeAppState({}, undefined)

    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('a refused write does not run the reconciler', async () => {
    const { store } = fakeStore({ ok: false })
    const reconcile = vi.fn(async () => undefined)
    const wrapped = await notifyAfterStateWrite(async () => store, reconcile)()

    await wrapped.writeAppState({}, undefined)

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('a reconciler that fails never fails the write', async () => {
    const { store } = fakeStore({ ok: true })
    const wrapped = await notifyAfterStateWrite(
      async () => store,
      async () => {
        throw new Error('boom')
      },
    )()

    await expect(wrapped.writeAppState({}, undefined)).resolves.toMatchObject({ ok: true })
  })
})

describe('I-01 forged links through sync.writeState', () => {
  it('a grant writing state creates neither link nor mirror', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    const writeMirror = vi.fn()
    createOrchestrationLinksMirror({
      links: harness.links,
      writeMirror,
      publish: vi.fn(),
      ids: { uuid: () => 'op', uuidV5: () => 'x' },
      readAppStateRevision: async () => 1,
      healthOf: () => 'ready',
    })
    const { store, writeAppState } = fakeStore({ ok: true })
    const surface = createControlSurface()
    registerSyncHandlers(surface, async () => store, {
      onStatePersisted: createStatePersistedHook(undefined, () =>
        harness.service.reconcileDeletedNodes(),
      ),
    })
    const grants = new SessionGrantRegistry(() => true)
    const { grant } = grants.issue({
      projectId: 'p1',
      spaceId: 's1',
      nodeId: 'orq',
      sessionId: 's',
    })
    const ctx = {
      ...user,
      requestAuth: { kind: 'session-grant', grant },
    } as unknown as ControlSurfaceContext
    const links = [...harness.links.rows.keys()]

    const forgedState = {
      orchestrationLinks: [{ executorNodeId: 'stranger' }],
      workspaces: [{ id: 'w1', spaces: [{ id: 's1', nodes: [{ id: 'other-project-node' }] }] }],
    }
    const attempts = await Promise.all(
      ['sync.writeState', 'sync.writeWorkspaceStateRaw'].map(id =>
        surface.invoke(ctx, {
          kind: 'command',
          id,
          payload:
            id === 'sync.writeState'
              ? { state: forgedState, baseRevision: 0 }
              : JSON.stringify(forgedState),
        } as never),
      ),
    )
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({ ok: false, error: { code: 'common.forbidden' } })
    }
    expect(writeAppState).not.toHaveBeenCalled()
    expect(harness.links.rows.get(links[0])!.closedAt).toBeNull()
    expect([...harness.links.rows.keys()]).toEqual(links)
    expect(writeMirror).not.toHaveBeenCalled()
    const forged = harness.service.dispatch(orchestratorPrincipal(), {
      dispatchId: '5b1c0000-0000-4000-8000-0000000000aa',
      to: 'stranger',
      text: 'x',
    })
    await expect(forged).rejects.toSatisfy(
      (error: unknown) => error instanceof OrchestrationError && error.code === 'orch.not_linked',
    )
    expect(harness.links.rows.get([...harness.links.rows.keys()][0])!.executorNodeId).toBe(
      executorNodeId,
    )
  })
})
