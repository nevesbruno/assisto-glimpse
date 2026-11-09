import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { migrate } from '../../../../src/platform/persistence/sqlite/migrate'
import {
  createExecutorLink,
  ORCHESTRATOR_PROVIDER,
  type AgentLink,
} from '../../../../src/contexts/orchestration/domain/agentLink'
import {
  createDispatch,
  type Dispatch,
} from '../../../../src/contexts/orchestration/domain/dispatch'
import type { SqliteHandle } from '../../../../src/contexts/orchestration/infrastructure/persistence/sqliteHandle'

export interface TempDatabase {
  readonly path: string
  open: () => SqliteHandle
  dispose: () => void
}

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

/** Real migrated SQLite file, so that several connections can see each other. */
export function createTempDatabase(): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'))
  const path = join(dir, 'app.db')
  const connections: DatabaseSync[] = []
  const open = (): SqliteHandle => {
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA busy_timeout = 2000')
    connections.push(raw)
    return raw as unknown as SqliteHandle
  }
  const first = new DatabaseSync(path)
  migrate(asMigrationHandle(first))
  first.close()
  return {
    path,
    open,
    dispose: () => {
      connections.forEach(raw => raw.close())
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const NOW = new Date('2026-11-09T12:00:00.000Z')

export function buildLink(
  id: string,
  executorNodeId = `exec-${id}`,
  overrides: Partial<AgentLink> = {},
): AgentLink {
  return {
    ...createExecutorLink({
      id,
      spaceId: 'space-1',
      orchestrator: { nodeId: 'orch-1', projectId: 'project-1', provider: ORCHESTRATOR_PROVIDER },
      executor: { nodeId: executorNodeId, projectId: 'project-1', provider: 'codex' },
      spawnRequestId: null,
      existingLinks: [],
      now: NOW,
    }),
    ...overrides,
  }
}

export function buildDispatch(id: string, link: AgentLink, minutes = 0): Dispatch {
  return createDispatch({
    id,
    link,
    text: `work ${id}`,
    textSha256: `sha-${id}`,
    now: new Date(NOW.getTime() + minutes * 60_000),
  }).dispatch
}
