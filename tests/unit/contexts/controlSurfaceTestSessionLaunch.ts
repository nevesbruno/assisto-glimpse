import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import type { MultiEndpointPtyRuntime } from '../../../src/app/main/controlSurface/ptyStream/multiEndpointPtyRuntime'
import type { PtyStreamHub } from '../../../src/app/main/controlSurface/ptyStream/ptyStreamHub'
import type { WorkerTopologyStore } from '../../../src/app/main/controlSurface/topology/topologyStore'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import type { ApprovedWorkspaceStore } from '../../../src/contexts/workspace/infrastructure/approval/ApprovedWorkspaceStore'

export function createSessionLaunchTestContext(): ControlSurfaceContext {
  return {
    now: () => new Date('2026-03-27T00:00:00.000Z'),
    capabilities: {
      webShell: false,
      sync: {
        state: true,
        events: true,
      },
      sessionStreaming: {
        enabled: true,
        ptyProtocolVersion: 1,
        replayWindowMaxBytes: 400_000,
        roles: {
          viewer: true,
          controller: true,
        },
        webAuth: {
          ticketToCookie: true,
          cookieSession: true,
        },
      },
    },
  }
}

export function createStubStore(state: unknown): PersistenceStore {
  return {
    readWorkspaceStateRaw: async () => null,
    writeWorkspaceStateRaw: async () => ({ ok: true, level: 'full', bytes: 0 }),
    readAppState: async () => state,
    writeAppState: async () => ({ ok: true, level: 'full', bytes: 1 }),
    readNodeScrollback: async () => null,
    writeNodeScrollback: async () => ({ ok: true, level: 'full', bytes: 0 }),
    consumeRecovery: () => null,
    dispose: () => undefined,
  } as unknown as PersistenceStore
}

export function createApprovedWorkspacesStub(): ApprovedWorkspaceStore {
  return {
    registerRoot: async () => undefined,
    isPathApproved: async () => true,
  } as unknown as ApprovedWorkspaceStore
}

export function createTopologyStub(): WorkerTopologyStore {
  return {
    listMounts: async () => ({ projectId: 'ws1', mounts: [] }),
  } as unknown as WorkerTopologyStore
}

export function createLocalMountTopology(rootPath: string, rootUri: string): WorkerTopologyStore {
  return {
    resolveMountTarget: async () => ({
      mountId: 'mount-local',
      projectId: 'project-local',
      targetId: 'target-local',
      endpointId: 'local',
      rootPath,
      rootUri,
    }),
  } as unknown as WorkerTopologyStore
}

export function createPtyStreamHubStub(overrides: Partial<PtyStreamHub> = {}): PtyStreamHub {
  return {
    registerSessionMetadata: () => undefined,
    hasSession: () => false,
    ...overrides,
  } as unknown as PtyStreamHub
}

export function createPtyRuntimeStub(
  overrides: Partial<MultiEndpointPtyRuntime> = {},
): MultiEndpointPtyRuntime {
  return {
    spawnSession: async () => ({ sessionId: 'pty-test-session' }),
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    onData: () => () => undefined,
    onExit: () => () => undefined,
    attach: () => undefined,
    detach: () => undefined,
    snapshot: () => '',
    startSessionStateWatcher: () => undefined,
    registerRemoteSession: () => 'remote-home-session',
    dispose: () => undefined,
    ...overrides,
  } as unknown as MultiEndpointPtyRuntime
}
