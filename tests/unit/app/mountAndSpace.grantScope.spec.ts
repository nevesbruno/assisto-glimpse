// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerPtyMountHandlers } from '../../../src/app/main/controlSurface/handlers/ptyMountHandlers'
import { registerWorkspaceBootstrapHandlers } from '../../../src/app/main/controlSurface/handlers/workspaceBootstrapHandlers'
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

describe('pty.spawnInMount under a grant', () => {
  function setup() {
    const spawn = vi.fn()
    const surface = createControlSurface()
    registerPtyMountHandlers(surface, {
      ...createReadyTerminalAdmissionDeps(),
      approvedWorkspaces: { isPathApproved: async () => true },
      topology: {
        resolveMountTarget: async ({ mountId }: { mountId: string }) =>
          mountId === 'mount-b'
            ? { projectId: 'project-b', endpointId: 'local', rootUri: 'file:///b' }
            : null,
      },
      ptyRuntime: { spawnSession: spawn },
      ptyStreamHub: {},
    } as never)
    const invoke = (mountId: string) =>
      surface.invoke(grantCtx('project-a'), {
        kind: 'command',
        id: 'pty.spawnInMount',
        payload: { mountId },
      })
    return { invoke, spawn }
  }

  it('answers a mount of another project exactly like an unknown mount', async () => {
    const { invoke, spawn } = setup()
    const foreign = await invoke('mount-b')
    expect(foreign).toMatchObject({
      ok: false,
      error: { code: 'common.invalid_input', debugMessage: 'Unknown mountId: mount-b' },
    })
    const unknown = await invoke('mount-ghost')
    const swap = (result: unknown, id: string) =>
      JSON.parse(JSON.stringify(result).replaceAll(id, '<id>'))
    expect(swap(foreign, 'mount-b')).toEqual(swap(unknown, 'mount-ghost'))
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('space.create under a grant', () => {
  async function setup() {
    const store = createInMemoryPersistenceStore()
    const state = createMinimalState('/a', 'project-a', 's-a')
    state.workspaces.push(createMinimalState('/b', 'project-b', 's-b').workspaces[0])
    await store.writeAppState(state)
    const writeAppState = vi.spyOn(store, 'writeAppState')
    const surface = createControlSurface()
    registerWorkspaceBootstrapHandlers(surface, {
      getPersistenceStore: async () => store,
      approvedWorkspaces: { registerRoot: vi.fn() },
      topology: {},
    } as never)
    writeAppState.mockClear()
    const invoke = (projectId: string) =>
      surface.invoke(grantCtx('project-a'), {
        kind: 'command',
        id: 'space.create',
        payload: { projectId, name: 'x' },
      })
    return { invoke, writeAppState }
  }

  it('answers a project of another project exactly like an unknown project, without writing', async () => {
    const { invoke, writeAppState } = await setup()
    const foreign = await invoke('project-b')
    expect(foreign).toMatchObject({
      ok: false,
      error: { code: 'common.invalid_input', debugMessage: 'Unknown projectId.' },
    })
    expect(foreign).toEqual(await invoke('project-ghost'))
    expect(writeAppState).not.toHaveBeenCalled()
  })
})
