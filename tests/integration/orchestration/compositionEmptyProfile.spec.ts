// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeOrchestration,
  type ComposeOrchestrationInput,
  type OrchestrationConnection,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestration'
import { migrate } from '../../../src/platform/persistence/sqlite/migrate'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'

const SCHEMA_DELAY_MS = 40

function asMigrationHandle(raw: DatabaseSync): Database.Database {
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    pragma: (query: string, options?: { simple?: boolean }) => {
      if (query.includes('=')) {
        raw.exec(`PRAGMA ${query}`)
        return undefined
      }
      const rows = raw.prepare(`PRAGMA ${query}`).all()
      const first = rows[0] as Record<string, unknown> | undefined
      return options?.simple === true && first ? Object.values(first)[0] : rows
    },
  } as unknown as Database.Database
}

describe('orchestration boot on an empty profile (I-09)', () => {
  const connections: DatabaseSync[] = []
  let dir = ''
  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.close()
    }
    rmSync(dir, { recursive: true, force: true })
  })

  /** As in production: the schema only exists once the lazy PersistenceStore is first requested. */
  function emptyProfile() {
    dir = mkdtempSync(join(tmpdir(), 'orchestration-empty-profile-'))
    const dbPath = join(dir, 'app.db')
    const open = (): DatabaseSync => {
      const raw = new DatabaseSync(dbPath)
      connections.push(raw)
      return raw
    }
    const store = {
      readAppState: async () => null,
      readAppStateRevision: async () => 0,
    } as unknown as PersistenceStore
    let creating: Promise<PersistenceStore> | null = null
    const getPersistenceStore = (): Promise<PersistenceStore> =>
      (creating ??= new Promise<PersistenceStore>(resolve =>
        setTimeout(() => {
          migrate(asMigrationHandle(open()))
          resolve(store)
        }, SCHEMA_DELAY_MS),
      ))
    return { open, getPersistenceStore }
  }

  it('waits for the schema before the reconciliation of the boot', async () => {
    const profile = emptyProfile()
    const log = vi.fn()
    const input: ComposeOrchestrationInput = {
      openDatabase: () => profile.open() as unknown as OrchestrationConnection,
      getPersistenceStore: profile.getPersistenceStore,
      topology: { listEndpoints: vi.fn(), listMounts: vi.fn() },
      ptyRuntime: { spawnSession: vi.fn(), kill: vi.fn(), onExit: () => () => {} } as never,
      registry: { register: vi.fn(), observe: vi.fn(), get: vi.fn() },
      schedule: () => () => {},
      log,
    }
    const composed = composeOrchestration(input)

    await composed.boot()

    expect(log).not.toHaveBeenCalledWith('orchestration boot step failed', expect.anything())
    expect(
      profile.open().prepare("SELECT name FROM sqlite_master WHERE name = 'agent_links'").get(),
    ).toBeDefined()
  })
})
