// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeOrchestration,
  type ComposeOrchestrationInput,
  type OrchestrationConnection,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestration'
import { createOrchestrationLinksMirror } from '../../../src/app/main/controlSurface/orchestration/orchestrationLinksMirror'
import { ORCHESTRATOR_PROVIDER } from '../../../src/contexts/orchestration/domain/agentLink'
import { DEFAULT_AGENT_SETTINGS } from '../../../src/contexts/settings/domain/agentSettings'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import { orchestrationLinksMirrorSchema } from '../../../src/shared/contracts/dto/orchestration'
import { FakeRuntime } from '../../unit/contexts/orchestration/application/fakes'
import { createTempDatabase, type TempDatabase } from './persistence/orchestrationDb'

let database: TempDatabase | null = null
afterEach(() => {
  database?.dispose()
  database = null
})

const node = (id: string, provider: string) => ({
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
})

/** Two agent nodes created by New Agent: they belong to the project, to no space. */
function composition() {
  database = createTempDatabase()
  const state = {
    formatVersion: 1,
    activeWorkspaceId: 'project-1',
    workspaces: [
      {
        id: 'project-1',
        name: 'P',
        path: '/work',
        nodes: [node('orch-1', ORCHESTRATOR_PROVIDER), node('exec-1', 'codex')],
        spaces: [],
      },
    ],
    settings: DEFAULT_AGENT_SETTINGS,
  }
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => 41,
    writeAppState: async () => ({ ok: true }),
  } as unknown as PersistenceStore
  const input: ComposeOrchestrationInput = {
    openDatabase: () =>
      Object.assign(database!.open(), { close: () => {} }) as OrchestrationConnection,
    getPersistenceStore: async () => store,
    topology: { listEndpoints: vi.fn(), listMounts: vi.fn() },
    ptyRuntime: {
      spawnSession: vi.fn(async () => ({ sessionId: 'pty-1' })) as never,
      kill: vi.fn(),
      onExit: () => () => {},
    },
    registry: { register: vi.fn(), observe: vi.fn(), get: vi.fn() },
    schedule: () => () => {},
    log: vi.fn(),
    codex: {
      startProcess: vi.fn(),
      createClient: vi.fn(),
      resolveExecutable: vi.fn(async () => ({ executablePath: '/bin/codex', version: '1' })),
    },
    createCodexFactory: deps => ({
      probe: async () => ({ executablePath: '/bin/codex', version: '1', compatible: true }),
      start: async spec => {
        await deps.resolveExecutable()
        return new FakeRuntime(spec)
      },
    }),
  }
  return composeOrchestration(input)
}

describe('link between nodes outside any space (I-10)', () => {
  it('accepts link.create and mirrors the link with an empty spaceId', async () => {
    const composed = composition()

    const created = await composed.service.createLink(
      { kind: 'user' },
      { orchestratorNodeId: 'orch-1', executorNodeId: 'exec-1' },
    )
    expect(created).toEqual({ linkId: expect.any(String), runtimeMode: expect.any(String) })

    const written: unknown[] = []
    const mirror = createOrchestrationLinksMirror({
      links: composed.links,
      writeMirror: value => void written.push(value),
      publish: () => {},
      ids: { uuid: () => 'op-1', uuidV5: () => 'unused' },
      readAppStateRevision: async () => 41,
      healthOf: () => 'ready',
    })
    await mirror.sync({ publish: false })

    const parsed = orchestrationLinksMirrorSchema.safeParse(written[0])
    expect(parsed.success).toBe(true)
    expect(parsed.data?.links).toEqual([
      expect.objectContaining({ id: created.linkId, spaceId: '', projectId: 'project-1' }),
    ])
  })
})
