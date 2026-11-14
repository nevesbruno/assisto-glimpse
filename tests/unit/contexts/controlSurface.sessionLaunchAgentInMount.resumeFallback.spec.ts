import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerSessionHandlers } from '../../../src/app/main/controlSurface/handlers/sessionHandlers'
import {
  createReadyTerminalAdmissionDeps,
  createTestAgentProviderRegistry,
} from './controlSurfaceTestTerminalAvailability'
import {
  createApprovedWorkspacesStub,
  createLocalMountTopology,
  createPtyRuntimeStub,
  createPtyStreamHubStub,
  createSessionLaunchTestContext,
} from './controlSurfaceTestSessionLaunch'

const resolveWorkerAgentTestStubMock = vi.hoisted(() => vi.fn())

vi.mock('../../../src/app/main/controlSurface/handlers/sessionAgentTestStub', () => ({
  resolveWorkerAgentTestStub: resolveWorkerAgentTestStubMock,
}))

const ctx = createSessionLaunchTestContext()

afterEach(() => {
  vi.unstubAllEnvs()
  resolveWorkerAgentTestStubMock.mockReset()
})

describe('control surface session.launchAgentInMount resume fallback', () => {
  it('returns the effective new mode for a mounted claude resume without a transcript', async () => {
    const homeDirectory = await fs.mkdtemp(join(tmpdir(), 'opencove-claude-mount-'))
    const rootPath = process.cwd()
    const rootUri = pathToFileURL(rootPath).href
    const spawnSession = vi.fn(async () => ({ sessionId: 'pty-mounted-claude-fallback' }))
    vi.stubEnv('HOME', homeDirectory)
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    resolveWorkerAgentTestStubMock.mockReturnValue(null)

    try {
      const controlSurface = createControlSurface()
      registerSessionHandlers(controlSurface, {
        ...createReadyTerminalAdmissionDeps(),
        agentProviderRegistry: createTestAgentProviderRegistry(),
        userDataPath: '/tmp/opencove-test-user-data',
        approvedWorkspaces: createApprovedWorkspacesStub(),
        getPersistenceStore: async () =>
          ({
            readAppState: async () => ({ settings: {} }),
          }) as never,
        ptyRuntime: createPtyRuntimeStub({
          spawnSession,
        }),
        ptyStreamHub: createPtyStreamHubStub(),
        topology: createLocalMountTopology(rootPath, rootUri),
      })

      const launched = await controlSurface.invoke(ctx, {
        kind: 'command',
        id: 'session.launchAgentInMount',
        payload: {
          mountId: 'mount-local',
          cwdUri: rootUri,
          prompt: '',
          provider: 'claude-code',
          mode: 'resume',
          resumeSessionId: 'missing-mounted-claude-session',
        },
      })

      expect(launched.ok).toBe(true)
      if (!launched.ok) {
        return
      }

      expect(launched.value.launchMode).toBe('new')
      expect(launched.value.resumeSessionId).toBe('missing-mounted-claude-session')

      const spawnedInput = spawnSession.mock.calls[0]?.[0] as { args?: string[] } | undefined
      expect(spawnedInput?.args).toEqual(
        expect.arrayContaining(['--session-id', 'missing-mounted-claude-session']),
      )
      expect(spawnedInput?.args).not.toContain('--resume')
    } finally {
      await fs.rm(homeDirectory, { recursive: true, force: true })
    }
  })
})
