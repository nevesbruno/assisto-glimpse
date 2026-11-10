// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeOrchestration,
  type ComposeOrchestrationInput,
  type OrchestrationConnection,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestration'
import { createRuntimeFactory } from '../../../src/app/main/controlSurface/orchestration/composeOrchestrationDeps'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import { createTempDatabase, type TempDatabase } from './persistence/orchestrationDb'

let database: TempDatabase | null = null
afterEach(() => {
  database?.dispose()
  database = null
})

function fixture() {
  database = createTempDatabase()
  const opened: { handle: OrchestrationConnection; closed: boolean }[] = []
  const input: ComposeOrchestrationInput = {
    openDatabase: () => {
      const raw = database!.open()
      const entry = {
        closed: false,
        handle: Object.assign(raw, {
          close: () => {
            entry.closed = true
          },
        }) as OrchestrationConnection,
      }
      opened.push(entry)
      return entry.handle
    },
    getPersistenceStore: async () => ({ readAppState: async () => null }) as PersistenceStore,
    topology: { listEndpoints: vi.fn(), listMounts: vi.fn() },
    ptyRuntime: { spawnSession: vi.fn(), kill: vi.fn(), onExit: () => () => {} },
    registry: { register: vi.fn(), observe: vi.fn(), get: vi.fn() },
    schedule: () => () => {},
    log: vi.fn(),
    codex: { startProcess: vi.fn(), createClient: vi.fn(), resolveExecutable: vi.fn() },
  }
  return { input, opened, composed: composeOrchestration(input) }
}

describe('orchestration composition (F2-14 4a)', () => {
  it('serves the orch operations from the composed service instead of common.unavailable', async () => {
    const { composed } = fixture()
    await expect(composed.service.status({ kind: 'user' }, {})).resolves.toBeDefined()
    await expect(composed.links.readLinksRevision()).resolves.toEqual(expect.any(Number))
  })

  it('uses its own connection, with busy_timeout 5000 and no open transaction', () => {
    const { opened } = fixture()
    const { handle } = opened[0]
    expect(handle.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    expect(() => handle.exec('BEGIN IMMEDIATE')).not.toThrow()
    handle.exec('ROLLBACK')
  })

  it('reads the full access option when the service starts', async () => {
    const readFullAccess: (() => boolean)[] = []
    const settings = { current: { agentFullAccess: false } }
    const factory = createRuntimeFactory({
      provider: 'codex',
      overrides: { startProcess: vi.fn(), createClient: vi.fn(), resolveExecutable: vi.fn() },
      approvedHooks: async () => [],
      getPersistenceStore: async () =>
        ({
          readAppState: async () => ({
            formatVersion: 1,
            workspaces: [],
            settings: settings.current,
          }),
        }) as unknown as PersistenceStore,
      createCodexFactory: deps => {
        readFullAccess.push(deps.readFullAccess)
        return { probe: vi.fn(), start: vi.fn() }
      },
    })
    settings.current = { agentFullAccess: true }
    await factory.start({} as never)
    expect(readFullAccess.at(-1)?.()).toBe(true)
  })

  it('revives nothing and answers null without an active service link', async () => {
    const { composed } = fixture()
    await expect(composed.reviveExecutorTui('exec-without-link')).resolves.toBeNull()
  })

  it('closes the connection on dispose', async () => {
    const { composed, opened } = fixture()
    await composed.dispose()
    expect(opened[0].closed).toBe(true)
  })
})
