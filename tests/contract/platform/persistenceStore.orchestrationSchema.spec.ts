// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DB_SCHEMA_VERSION } from '../../../src/platform/persistence/sqlite/constants'
import { migrate } from '../../../src/platform/persistence/sqlite/migrate'
import { CURRENT_SCHEMA_COLUMNS } from './persistenceSchemaColumns'

const ORCHESTRATION_TABLES = [
  'agent_links',
  'orchestration_dispatches',
  'orchestration_notices',
  'orchestration_hook_approvals',
] as const

type SqlValue = string | number | null

/** Real SQLite (node:sqlite) behind the slice of the better-sqlite3 API that migrate() uses. */
function openDb(): { raw: DatabaseSync; db: Database.Database } {
  const raw = new DatabaseSync(':memory:')
  const db = {
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
  return { raw, db }
}

let open: DatabaseSync | null = null

function openMigrated(): { raw: DatabaseSync; db: Database.Database } {
  const handles = openDb()
  open = handles.raw
  migrate(handles.db)
  return handles
}

function columnsOf(raw: DatabaseSync, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    row => row.name,
  )
}

function insert(raw: DatabaseSync, table: string, values: Record<string, SqlValue>): void {
  const keys = Object.keys(values)
  raw
    .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...Object.values(values))
}

let sequence = 0

function link(raw: DatabaseSync, values: Record<string, SqlValue>): void {
  sequence += 1
  insert(raw, 'agent_links', {
    id: `link-${sequence}`,
    project_id: 'project-1',
    space_id: 'space-1',
    orchestrator_node_id: 'orchestrator-1',
    executor_node_id: 'executor-1',
    provider: 'codex',
    created_at: 'now',
    updated_at: 'now',
    ...values,
  })
}

function dispatch(raw: DatabaseSync, values: Record<string, SqlValue>): void {
  sequence += 1
  insert(raw, 'orchestration_dispatches', {
    id: `dispatch-${sequence}`,
    link_id: 'link-1',
    executor_node_id: 'executor-1',
    orchestrator_node_id: 'orchestrator-1',
    round: 1,
    text_sha256: 'hash',
    text_bytes: 4,
    deadline_at: 'later',
    created_at: 'now',
    ...values,
  })
}

function schemaSnapshot(raw: DatabaseSync): unknown {
  return raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()
}

describe('persistence schema 14 for orchestration (C-01)', () => {
  afterEach(() => {
    open?.close()
    open = null
  })

  it('refuses a link without space_id and a dispatch without deadline_at', () => {
    const { raw } = openMigrated()

    expect(() => link(raw, { space_id: null })).toThrow(/NOT NULL/)
    expect(() => dispatch(raw, { deadline_at: null })).toThrow(/NOT NULL/)
  })

  it('creates the four tables with the documented columns and the revision key', () => {
    const { raw } = openMigrated()

    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: DB_SCHEMA_VERSION })
    expect(DB_SCHEMA_VERSION).toBe(14)
    for (const table of ORCHESTRATION_TABLES) {
      expect(columnsOf(raw, table)).toEqual([...CURRENT_SCHEMA_COLUMNS[table]])
    }
    expect(
      raw.prepare(`SELECT value FROM app_meta WHERE key = 'orchestration_links_revision'`).get(),
    ).toEqual({ value: '0' })
  })

  it('gives phase 3 columns a neutral default for phase 2 links', () => {
    const { raw } = openMigrated()
    link(raw, {})

    expect(raw.prepare('SELECT * FROM agent_links').get()).toMatchObject({
      kind: 'executor',
      origin: 'orchestrator_spawn',
      runtime_mode: 'service',
      state: 'active',
      close_reason: null,
      request_reason: null,
      requested_at: null,
      messages_limit: 5,
      messages_used_source: 0,
      messages_used_target: 0,
      rounds_used: 0,
      rounds_limit: 3,
      spawn_request_id: null,
      revision: 1,
    })
  })

  it('refuses a second active link for the same executor and allows relinking after close', () => {
    const { raw } = openMigrated()
    link(raw, {})

    expect(() => link(raw, { orchestrator_node_id: 'orchestrator-2' })).toThrow(/UNIQUE/)
    link(raw, { executor_node_id: 'executor-2' })

    raw.exec(`UPDATE agent_links SET state = 'closed' WHERE executor_node_id = 'executor-1'`)
    link(raw, {})
    link(raw, { state: 'closed' })
  })

  it('refuses a second open dispatch per executor, queued included, and ignores final states', () => {
    const { raw } = openMigrated()

    dispatch(raw, { state: 'queued' })
    for (const state of ['queued', 'reserved', 'sent', 'uncertain']) {
      expect(() => dispatch(raw, { state })).toThrow(/UNIQUE/)
    }
    dispatch(raw, { state: 'completed' })
    dispatch(raw, { state: 'cancelled' })
    dispatch(raw, { state: 'failed' })
    dispatch(raw, { executor_node_id: 'executor-2', state: 'sent' })

    raw.exec(`UPDATE orchestration_dispatches SET state = 'cancelled' WHERE state = 'queued'`)
    dispatch(raw, { state: 'reserved' })
    expect(() => dispatch(raw, { state: 'queued' })).toThrow(/UNIQUE/)
  })

  it('names the index orchestration_dispatches_open_executor_unique_idx and drops the old one', () => {
    const { raw } = openMigrated()
    const names = (
      raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
        name: string
      }[]
    ).map(row => row.name)

    expect(names).toContain('orchestration_dispatches_open_executor_unique_idx')
    expect(names).not.toContain('orchestration_dispatches_in_flight_executor_unique_idx')
  })

  describe('repair of a development database 14 that still has the old index', () => {
    function openOldIndexDb() {
      const handles = openMigrated()
      handles.raw.exec(`
        DROP INDEX orchestration_dispatches_open_executor_unique_idx;
        CREATE UNIQUE INDEX orchestration_dispatches_in_flight_executor_unique_idx
          ON orchestration_dispatches (executor_node_id)
          WHERE state IN ('reserved', 'sent', 'uncertain');
      `)
      return handles
    }

    const states = (raw: DatabaseSync) =>
      raw
        .prepare('SELECT id, state, text, revision FROM orchestration_dispatches ORDER BY id')
        .all()

    it('keeps the oldest queued per executor, cancels the rest and returns their rounds', () => {
      const { raw, db } = openOldIndexDb()
      link(raw, { id: 'link-a', rounds_used: 3 })
      dispatch(raw, { id: 'a1', link_id: 'link-a', state: 'queued', created_at: '1', text: 't' })
      dispatch(raw, { id: 'a2', link_id: 'link-a', state: 'queued', created_at: '2', text: 't' })
      dispatch(raw, { id: 'a3', link_id: 'link-a', state: 'queued', created_at: '3', text: 't' })

      expect(() => migrate(db)).not.toThrow()

      expect(states(raw)).toEqual([
        { id: 'a1', state: 'queued', text: 't', revision: 1 },
        { id: 'a2', state: 'cancelled', text: null, revision: 2 },
        { id: 'a3', state: 'cancelled', text: null, revision: 2 },
      ])
      expect(raw.prepare(`SELECT rounds_used, revision FROM agent_links`).get()).toEqual({
        rounds_used: 1,
        revision: 2,
      })
      expect(
        raw.prepare(`SELECT value FROM app_meta WHERE key = 'orchestration_links_revision'`).get(),
      ).toEqual({ value: '1' })
      expect(() => dispatch(raw, { state: 'queued' })).toThrow(/UNIQUE/)
    })

    it('cancels every queued dispatch of an executor that already has one in flight', () => {
      const { raw, db } = openOldIndexDb()
      link(raw, { id: 'link-a', rounds_used: 2 })
      dispatch(raw, { id: 'a1', link_id: 'link-a', state: 'sent', created_at: '1' })
      dispatch(raw, { id: 'a2', link_id: 'link-a', state: 'queued', created_at: '2', text: 't' })

      migrate(db)

      expect(states(raw).map(row => (row as { state: string }).state)).toEqual([
        'sent',
        'cancelled',
      ])
      expect(raw.prepare(`SELECT rounds_used FROM agent_links`).get()).toEqual({ rounds_used: 1 })
    })

    it('is idempotent and leaves a clean database alone', () => {
      const { raw, db } = openOldIndexDb()
      link(raw, { id: 'link-a', rounds_used: 2 })
      dispatch(raw, { id: 'a1', link_id: 'link-a', state: 'queued', created_at: '1' })
      dispatch(raw, { id: 'a2', link_id: 'link-a', state: 'queued', created_at: '2' })

      migrate(db)
      const once = [
        schemaSnapshot(raw),
        states(raw),
        raw.prepare('SELECT * FROM agent_links').all(),
      ]
      migrate(db)

      expect([
        schemaSnapshot(raw),
        states(raw),
        raw.prepare('SELECT * FROM agent_links').all(),
      ]).toEqual(once)
    })
  })

  it('makes spawn_request_id unique per orchestrator and lets null repeat', () => {
    const { raw } = openMigrated()

    link(raw, { executor_node_id: 'e1', spawn_request_id: 'req-1' })
    expect(() => link(raw, { executor_node_id: 'e2', spawn_request_id: 'req-1' })).toThrow(/UNIQUE/)
    link(raw, {
      executor_node_id: 'e3',
      orchestrator_node_id: 'orchestrator-2',
      spawn_request_id: 'req-1',
    })
    link(raw, { executor_node_id: 'e4' })
    link(raw, { executor_node_id: 'e5' })
  })

  it('refuses a repeated notice dedupe key and a repeated hook approval', () => {
    const { raw } = openMigrated()
    const notice = {
      orchestrator_node_id: 'o',
      executor_node_id: 'e',
      kind: 'completed',
      dedupe_key: 'd1:completed',
      payload_json: '{}',
      created_at: 'now',
    }
    insert(raw, 'orchestration_notices', { id: 'n1', ...notice })
    expect(() => insert(raw, 'orchestration_notices', { id: 'n2', ...notice })).toThrow(/UNIQUE/)

    const approval = {
      hook_key: 'k',
      current_hash: 'h',
      event_name: 'Stop',
      source_path: '/p',
      approved_at: 'now',
      approved_by: 'user',
    }
    insert(raw, 'orchestration_hook_approvals', approval)
    expect(() => insert(raw, 'orchestration_hook_approvals', approval)).toThrow(/UNIQUE|PRIMARY/)
    insert(raw, 'orchestration_hook_approvals', { ...approval, current_hash: 'h2' })
  })

  it('repairs idempotently on the second open without touching data', () => {
    const { raw, db } = openMigrated()
    link(raw, { spawn_request_id: 'req-1' })
    raw.exec(`UPDATE app_meta SET value = '7' WHERE key = 'orchestration_links_revision'`)
    const before = schemaSnapshot(raw)
    const linksBefore = raw.prepare('SELECT * FROM agent_links').all()

    migrate(db)

    expect(schemaSnapshot(raw)).toEqual(before)
    expect(raw.prepare('SELECT * FROM agent_links').all()).toEqual(linksBefore)
    expect(
      raw.prepare(`SELECT value FROM app_meta WHERE key = 'orchestration_links_revision'`).get(),
    ).toEqual({ value: '7' })
  })

  it('upgrades a version 13 database keeping its data and adding the new tables', () => {
    const { raw, db } = openMigrated()
    insert(raw, 'workspaces', {
      id: 'ws-1',
      name: 'Kept',
      path: '/p',
      worktrees_root: '/w',
      viewport_x: 0,
      viewport_y: 0,
      viewport_zoom: 1,
      is_minimap_visible: 1,
    })
    for (const table of ORCHESTRATION_TABLES) {
      raw.exec(`DROP TABLE ${table}`)
    }
    raw.exec(
      `DELETE FROM app_meta WHERE key = 'orchestration_links_revision'; PRAGMA user_version = 13`,
    )

    migrate(db)

    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 14 })
    expect(raw.prepare('SELECT name FROM workspaces').all()).toEqual([{ name: 'Kept' }])
    for (const table of ORCHESTRATION_TABLES) {
      expect(columnsOf(raw, table)).toEqual([...CURRENT_SCHEMA_COLUMNS[table]])
    }
  })
})
