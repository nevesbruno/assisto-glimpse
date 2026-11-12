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
  it('answers a workspace of another project exactly like an unknown one, touching nothing', async () => {
    const { invoke, readAppState, restoreTerminalSession } = await setup()
    const foreign = await invoke('project-b')
    expect(foreign.ok).toBe(false)
    expect(readAppState).not.toHaveBeenCalled()
    expect(restoreTerminalSession).not.toHaveBeenCalled()
    const unknown = await invoke('project-ghost')
    const normalize = (result: unknown, id: string) =>
      JSON.parse(JSON.stringify(result).replaceAll(id, '<id>'))
    expect(normalize(foreign, 'project-b')).toEqual(normalize(unknown, 'project-ghost'))
    expect(foreign).toMatchObject({ ok: false, error: { code: 'common.invalid_input' } })
  })

  it('still serves the grant own workspace', async () => {
    const { invoke } = await setup()
    expect(await invoke('project-a')).toMatchObject({
      ok: true,
      value: { workspaceId: 'project-a' },
    })
  })
})
