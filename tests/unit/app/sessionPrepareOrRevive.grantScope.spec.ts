// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerSessionPrepareOrReviveHandler } from '../../../src/app/main/controlSurface/handlers/sessionPrepareOrReviveHandler'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { createReadyTerminalAdmissionDeps } from '../contexts/controlSurfaceTestTerminalAvailability'
import {
  createInMemoryPersistenceStore,
  createMinimalState,
} from '../../contract/controlSurface/controlSurfaceHttpServer.sessionStreaming.testUtils'

const grantCtx = (projectId: string): ControlSurfaceContext => ({
  now: () => new Date(),
  requestAuth: {
    kind: 'session-grant',
    grant: {
      projectId,
      spaceId: 's-a',
      nodeId: 'n-a',
      sessionId: 'sess',
      grantId: 'g',
      tier: 'interact',
      createdAt: '',
    },
  },
})

async function setup() {
  const store = createInMemoryPersistenceStore()
  const state = createMinimalState('/a', 'project-a', 's-a')
  state.workspaces.push(createMinimalState('/b', 'project-b', 's-b').workspaces[0])
  await store.writeAppState(state)
  const readAppState = vi.spyOn(store, 'readAppState')
  const restoreTerminalSession = vi.fn(async () => true)
  const surface = createControlSurface()
  registerSessionPrepareOrReviveHandler(surface, {
    ...createReadyTerminalAdmissionDeps(),
    getPersistenceStore: async () => store,
    ptyStreamHub: { isSessionActive: vi.fn(() => false) } as never,
    ptyRuntime: { write: vi.fn() },
    restoreTerminalSession,
  })
  const invoke = (workspaceId: string) =>
    surface.invoke(grantCtx('project-a'), {
      kind: 'command',
      id: 'session.prepareOrRevive',
      payload: { workspaceId },
    })
  return { invoke, readAppState, restoreTerminalSession }
}

describe('session.prepareOrRevive under a grant', () => {
  it('refuses every grant caller without reading state or restoring a session', async () => {
    // Upstream schema S1d: session recovery stays managed by OpenCove.
    const { invoke, readAppState, restoreTerminalSession } = await setup()
    for (const workspaceId of ['project-b', 'project-ghost', 'project-a']) {
      expect(await invoke(workspaceId)).toMatchObject({
        ok: false,
        error: { code: 'common.forbidden', details: { reason: 'operation_denied' } },
      })
    }
    expect(readAppState).not.toHaveBeenCalled()
    expect(restoreTerminalSession).not.toHaveBeenCalled()
  })
})
