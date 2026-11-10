// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrchestrationLinksMirror } from '../../../../src/shared/contracts/dto/orchestration'
import { migrate } from '../../../../src/platform/persistence/sqlite/migrate'
import { normalizePersistedAppState } from '../../../../src/platform/persistence/sqlite/normalize'
import { readAppStateFromDb } from '../../../../src/platform/persistence/sqlite/read'
import {
  writeNormalizedAppState,
  writeOrchestrationLinksMirror,
} from '../../../../src/platform/persistence/sqlite/write'
import { mergePersistedAppStates } from '../../../../src/shared/sync/mergePersistedAppStates'

type Row = unknown[]

/** Real SQLite (node:sqlite) behind the slice of better-sqlite3 that migrate, write and drizzle use. */
function openDb(): { raw: DatabaseSync; sqlite: Database.Database; db: BetterSQLite3Database } {
  const raw = new DatabaseSync(':memory:')
  const sqlite = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const statement = raw.prepare(sql)
      return {
        run: (...params: never[]) => statement.run(...params),
        get: (...params: never[]) => statement.get(...params),
        all: (...params: never[]) => statement.all(...params),
        raw: () => ({
          all: (...params: never[]): Row[] =>
            statement.all(...params).map(row => Object.values(row as object)),
          get: (...params: never[]): Row | undefined => {
            const row = statement.get(...params)
            return row ? Object.values(row as object) : undefined
          },
        }),
      }
    },
    transaction: (work: () => unknown) => () => {
      raw.exec('BEGIN')
      try {
        const result = work()
        raw.exec('COMMIT')
        return result
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
    },
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
  migrate(sqlite)
  return { raw, sqlite, db: drizzle(sqlite) }
}

const LINK_ID = '2f1c3b0e-6d5a-4b8e-9a77-1d3f5c7a9b11'

function mirrorOf(
  linksRevision: number,
  health: 'ready' | 'busy' = 'ready',
): OrchestrationLinksMirror {
  return {
    linksRevision,
    links: [
      {
        id: LINK_ID,
        projectId: 'ws-1',
        spaceId: 'space-1',
        orchestratorNodeId: 'orch-1',
        executorNodeId: 'exec-1',
        kind: 'executor',
        origin: 'orchestrator_spawn',
        runtimeMode: 'service',
        provider: 'codex',
        state: 'active',
        closeReason: null,
        health,
        roundsUsed: 0,
        roundsLimit: 3,
        createdAt: '2026-11-10T10:00:00.000Z',
        updatedAt: '2026-11-10T10:00:00.000Z',
        revision: 1,
      },
    ],
  }
}

function appState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    activeWorkspaceId: 'ws-1',
    workspaces: [{ id: 'ws-1', name: 'Project', path: '/tmp/ws-1', worktreesRoot: '/tmp' }],
    settings: {},
    ...extra,
  }
}

function normalized(value: unknown) {
  const result = normalizePersistedAppState(value)
  if (!result) {
    throw new Error('state did not normalize')
  }
  return result
}

function revisionOf(raw: DatabaseSync): string | undefined {
  const row = raw.prepare("SELECT value FROM app_meta WHERE key = 'app_state_revision'").get() as
    | { value: string }
    | undefined
  return row?.value
}

describe('orchestration links mirror in the synced app state', () => {
  let handle: ReturnType<typeof openDb>

  beforeEach(() => {
    handle = openDb()
  })
  afterEach(() => handle.raw.close())

  it('round-trips the mirror through writeNormalizedAppState and readAppStateFromDb', () => {
    const mirror = mirrorOf(4)
    writeNormalizedAppState(handle.sqlite, normalized(appState({ orchestrationLinks: mirror })))

    expect(readAppStateFromDb(handle.db)?.orchestrationLinks).toEqual(mirror)
  })

  it('leaves the state without a mirror when none was written', () => {
    writeNormalizedAppState(handle.sqlite, normalized(appState()))

    expect(readAppStateFromDb(handle.db)?.orchestrationLinks).toBeUndefined()
  })

  it('writes the mirror alone, without touching the revision or the workspaces', () => {
    writeNormalizedAppState(handle.sqlite, normalized(appState()))
    const before = readAppStateFromDb(handle.db)
    const revision = revisionOf(handle.raw)

    writeOrchestrationLinksMirror(handle.sqlite, mirrorOf(2))

    expect(revisionOf(handle.raw)).toBe(revision)
    const after = readAppStateFromDb(handle.db)
    expect(after?.orchestrationLinks).toEqual(mirrorOf(2))
    expect({ ...after, orchestrationLinks: undefined }).toEqual({
      ...before,
      orchestrationLinks: undefined,
    })
  })

  it('replaces the previous mirror on each write', () => {
    writeNormalizedAppState(handle.sqlite, normalized(appState()))
    writeOrchestrationLinksMirror(handle.sqlite, mirrorOf(2))
    writeOrchestrationLinksMirror(handle.sqlite, mirrorOf(3, 'busy'))

    expect(readAppStateFromDb(handle.db)?.orchestrationLinks).toEqual(mirrorOf(3, 'busy'))
  })

  it('ignores a stored mirror that fails the schema', () => {
    writeNormalizedAppState(handle.sqlite, normalized(appState()))
    handle.raw
      .prepare(
        "INSERT INTO app_meta (key, value) VALUES ('orchestration_links_mirror', '{\"links\":1}')",
      )
      .run()

    expect(readAppStateFromDb(handle.db)?.orchestrationLinks).toBeUndefined()
  })

  it('keeps the Worker mirror when a window writes a forged or outdated one', () => {
    writeNormalizedAppState(handle.sqlite, normalized(appState()))
    writeOrchestrationLinksMirror(handle.sqlite, mirrorOf(9))

    for (const forged of [mirrorOf(1), mirrorOf(99, 'busy'), undefined]) {
      const base = readAppStateFromDb(handle.db)
      const local = normalized(forged ? appState({ orchestrationLinks: forged }) : appState())
      const merged = mergePersistedAppStates(
        base as never,
        local as never,
        base as never,
      ) as unknown
      writeNormalizedAppState(handle.sqlite, normalized(merged))

      expect(readAppStateFromDb(handle.db)?.orchestrationLinks).toEqual(mirrorOf(9))
    }
  })
})
