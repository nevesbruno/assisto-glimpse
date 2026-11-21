// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeOrchestration,
  type ComposeOrchestrationInput,
  type OrchestrationConnection,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestration'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import { DEFAULT_AGENT_SETTINGS } from '../../../src/contexts/settings/domain/agentSettings'
import { ORCHESTRATOR_PROVIDER } from '../../../src/contexts/orchestration/domain/agentLink'
import { FakeRuntime } from '../../unit/contexts/orchestration/application/fakes.runtime'
import { createTempDatabase, type TempDatabase } from './persistence/orchestrationDb'

const ORCHESTRATOR_NODE = 'orch-1'
const AS_USER = { kind: 'user' } as const
const REQUEST = '7f3a2c1e-5b4d-4e6f-8a9b-0c1d2e3f4a5b'

let database: TempDatabase | null = null
afterEach(() => {
  database?.dispose()
  database = null
})

function node(id: string, provider: string) {
  return {
    id,
    title: id,
    position: { x: 0, y: 0 },
    width: 400,
    height: 300,
    kind: 'agent',
    status: 'running',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    lastError: null,
    scrollback: null,
    executionDirectory: '/work',
    agent: { provider, prompt: '', model: null, effectiveModel: null, launchMode: 'new' },
  }
}

function fixture() {
  database = createTempDatabase()
  let state: Record<string, unknown> = {
    formatVersion: 1,
    activeWorkspaceId: 'project-1',
    workspaces: [
      {
        id: 'project-1',
        name: 'P',
        path: '/work',
        nodes: [node(ORCHESTRATOR_NODE, ORCHESTRATOR_PROVIDER)],
        spaces: [
          { id: 'space-1', name: 'S', directoryPath: '/work', nodeIds: [ORCHESTRATOR_NODE] },
        ],
      },
    ],
    settings: DEFAULT_AGENT_SETTINGS,
  }
  const writes: Record<string, unknown>[] = []
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => 1,
    writeAppState: async (next: Record<string, unknown>) => {
      writes.push(structuredClone(next))
      state = next
      return { ok: true }
    },
  } as unknown as PersistenceStore
  const openCodeStarts: FakeRuntime[] = []
  const openCodeSpecs: string[] = []
  const codexStarts: string[] = []
  const spawnSession = vi.fn(async () => ({ sessionId: 'pty-1' }))
  const input: ComposeOrchestrationInput = {
    openDatabase: () =>
      Object.assign(database!.open(), { close: () => undefined }) as OrchestrationConnection,
    getPersistenceStore: async () => store,
    topology: {
      listEndpoints: async () => ({ endpoints: [] }),
      listMounts: async () => ({ mounts: [] }),
    },
    ptyRuntime: { spawnSession: spawnSession as never, kill: vi.fn(), onExit: () => () => {} },
    registry: { register: vi.fn(), observe: vi.fn(), get: vi.fn() },
    schedule: () => () => {},
    log: vi.fn(),
    codex: {
      startProcess: vi.fn(),
      createClient: vi.fn(),
      resolveExecutable: vi.fn(async () => ({ executablePath: '/bin/codex', version: '0.167.0' })),
    },
    openCode: {
      startProcess: vi.fn(),
      createClient: vi.fn(),
      resolveExecutable: vi.fn(async () => ({
        executablePath: '/bin/opencode',
        version: '2.3.0',
      })),
    },
    createCodexFactory: () => {
      codexStarts.push('codex')
      return { probe: vi.fn(), start: vi.fn() }
    },
    createOpenCodeFactory: deps => ({
      probe: async () => {
        await deps.resolveExecutable()
        return { executablePath: '/bin/opencode', version: '2.3.0', compatible: true }
      },
      start: async spec => {
        await deps.resolveExecutable()
        openCodeSpecs.push(spec.provider)
        const runtime = new FakeRuntime(spec)
        runtime.attachInfo = async () => ({
          url: 'http://127.0.0.1:4555',
          tokenEnv: { name: 'OPENCODE_SERVER_PASSWORD', value: 'pw' },
          sessionRef: 'ses_x',
          cwd: spec.cwd,
        })
        openCodeStarts.push(runtime)
        return runtime
      },
    }),
  }
  return { input, writes, openCodeStarts, openCodeSpecs, codexStarts, spawnSession }
}

describe('opencode composition (F3-01)', () => {
  it('spawns an opencode node with the opencode factory and the opencode TUI', async () => {
    const { input, writes, openCodeStarts, openCodeSpecs, codexStarts, spawnSession } = fixture()
    const composed = composeOrchestration(input)
    const result = await composed.service.spawn(AS_USER, {
      requestId: REQUEST,
      provider: 'opencode',
      orchestratorNodeId: ORCHESTRATOR_NODE,
    })

    expect(openCodeSpecs).toEqual(['opencode'])
    expect(openCodeStarts).toHaveLength(1)
    expect(codexStarts).toEqual([])

    const created = writes
      .flatMap(write =>
        (write['workspaces'] as { nodes: { id: string; agent: { provider: string } }[] }[]).flatMap(
          workspace => workspace.nodes,
        ),
      )
      .find(candidate => candidate.id === result.executorNodeId)
    expect(created?.agent.provider).toBe('opencode')

    expect(spawnSession).toHaveBeenCalledTimes(1)
    expect(spawnSession.mock.calls[0][0]).toMatchObject({
      command: '/bin/opencode',
      args: ['--server', 'http://127.0.0.1:4555', '--session', 'ses_x', '/work'],
      injectedEnv: { OPENCODE_SERVER_PASSWORD: 'pw' },
    })

    const status = await composed.service.status(AS_USER, {})
    expect(status.links).toHaveLength(1)
    expect(status.links[0].provider).toBe('opencode')
    await composed.dispose()
  })
})
