import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerSessionHandlers } from '../../../src/app/main/controlSurface/handlers/sessionHandlers'
import {
  createReadyTerminalAdmissionDeps,
  createTestAgentProviderRegistry,
} from './controlSurfaceTestTerminalAvailability'
import {
  createApprovedWorkspacesStub,
  createPtyRuntimeStub,
  createPtyStreamHubStub,
  createSessionLaunchTestContext,
  createStubStore,
  createTopologyStub,
} from './controlSurfaceTestSessionLaunch'

// This suite checks provider contribution dispatch. Platform shell wrapping has its own
// resolver tests; using the host resolver here makes the command assertions Windows-dependent.
vi.mock('../../../src/contexts/agent/infrastructure/cli/AgentLaunchSpawnResolver', () => ({
  resolveAgentLaunchSpawn: async (input: {
    cwd: string
    command: string
    args: string[]
    profileId?: string | null
    env?: NodeJS.ProcessEnv
  }) => ({
    ...input,
    profileId: input.profileId ?? null,
    env: input.env ?? {},
    runtimeKind: 'posix',
  }),
}))

const ctx = createSessionLaunchTestContext()
const originalUseRealAgents = process.env.OPENCOVE_TEST_USE_REAL_AGENTS

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalUseRealAgents === undefined) {
    delete process.env.OPENCOVE_TEST_USE_REAL_AGENTS
  } else {
    process.env.OPENCOVE_TEST_USE_REAL_AGENTS = originalUseRealAgents
  }
})

describe('control surface session launch agent resume fallback', () => {
  it('returns the effective new mode when a claude resume transcript is missing', async () => {
    const homeDirectory = await fs.mkdtemp(path.join(tmpdir(), 'opencove-claude-handler-'))
    vi.stubEnv('HOME', homeDirectory)
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    process.env.OPENCOVE_TEST_USE_REAL_AGENTS = '1'

    try {
      const spawnSession = vi.fn(async () => ({ sessionId: 'pty-claude-fallback' }))
      const controlSurface = createControlSurface()
      registerSessionHandlers(controlSurface, {
        ...createReadyTerminalAdmissionDeps(),
        agentProviderRegistry: createTestAgentProviderRegistry(),
        userDataPath: '/tmp/opencove-test-user-data',
        approvedWorkspaces: createApprovedWorkspacesStub(),
        getPersistenceStore: async () =>
          createStubStore({
            settings: { agentFullAccess: true },
          }),
        ptyRuntime: createPtyRuntimeStub({
          spawnSession,
        }),
        ptyStreamHub: createPtyStreamHubStub(),
        topology: createTopologyStub(),
      })

      const launched = await controlSurface.invoke(ctx, {
        kind: 'command',
        id: 'session.launchAgent',
        payload: {
          cwd: '/repo',
          prompt: '',
          provider: 'claude-code',
          mode: 'resume',
          resumeSessionId: 'missing-claude-session',
        },
      })

      expect(launched.ok).toBe(true)
      if (!launched.ok) {
        return
      }

      expect(launched.value.launchMode).toBe('new')

      const spawnedInput = spawnSession.mock.calls[0]?.[0] as { args?: string[] } | undefined
      expect(spawnedInput?.args).toEqual(
        expect.arrayContaining(['--session-id', 'missing-claude-session']),
      )
      expect(spawnedInput?.args).not.toContain('--resume')
    } finally {
      await fs.rm(homeDirectory, { recursive: true, force: true })
    }
  })
})
