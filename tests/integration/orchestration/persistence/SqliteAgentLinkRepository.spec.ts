// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeLink } from '../../../../src/contexts/orchestration/domain/agentLink'
import { SqliteAgentLinkRepository } from '../../../../src/contexts/orchestration/infrastructure/persistence/SqliteAgentLinkRepository'
import { buildLink, createTempDatabase, type TempDatabase } from './orchestrationDb'

let database: TempDatabase
let repo: SqliteAgentLinkRepository

beforeEach(() => {
  database = createTempDatabase()
  repo = new SqliteAgentLinkRepository(database.open())
})

afterEach(() => database.dispose())

describe('SqliteAgentLinkRepository', () => {
  it('inserts, reads back and bumps the links revision in the same change', async () => {
    const link = buildLink('l1')
    expect(await repo.readLinksRevision()).toBe(0)
    expect(await repo.insert(link)).toEqual({ ok: true, value: link })
    expect(await repo.findById('l1')).toEqual(link)
    expect(await repo.findActiveByExecutor(link.executorNodeId)).toEqual(link)
    expect(await repo.readLinksRevision()).toBe(1)
  })

  it('refuses a second active link for the executor, a repeated spawn request and a repeated id without bumping', async () => {
    await repo.insert(buildLink('l1', 'exec-a', { spawnRequestId: 'spawn-1' }))
    expect(await repo.insert(buildLink('l2', 'exec-a'))).toEqual({
      ok: false,
      reason: 'executor_already_linked',
    })
    expect(await repo.insert(buildLink('l3', 'exec-b', { spawnRequestId: 'spawn-1' }))).toEqual({
      ok: false,
      reason: 'spawn_request_duplicate',
    })
    expect(await repo.insert(buildLink('l1', 'exec-c'))).toEqual({ ok: false, reason: 'id_exists' })
    expect(await repo.readLinksRevision()).toBe(1)
    expect((await repo.findBySpawnRequest('orch-1', 'spawn-1'))?.id).toBe('l1')
  })

  it('updates with the next revision and bumps the links revision', async () => {
    const link = buildLink('l1')
    await repo.insert(link)
    const closed = closeLink(link, 'user', new Date('2026-11-09T13:00:00.000Z'))
    expect(await repo.update(closed)).toEqual({ ok: true, value: closed })
    expect(await repo.findById('l1')).toEqual(closed)
    expect(await repo.findActiveByExecutor(link.executorNodeId)).toBeNull()
    expect(await repo.readLinksRevision()).toBe(2)
  })

  it('answers revision_conflict for a stale revision without writing, and not_found for a missing id', async () => {
    const link = buildLink('l1')
    await repo.insert(link)
    const stale = { ...closeLink(link, 'user', new Date()), revision: 1 }
    const outdated = { ...link, roundsUsed: 1, revision: 5 }
    expect(await repo.update(stale)).toEqual({ ok: false, reason: 'revision_conflict' })
    expect(await repo.update(outdated)).toEqual({ ok: false, reason: 'revision_conflict' })
    expect(await repo.update(buildLink('ghost', 'exec-x', { revision: 2 }))).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(await repo.findById('l1')).toEqual(link)
    expect(await repo.readLinksRevision()).toBe(1)
  })

  it('lets only one of two connections win the same revision', async () => {
    const link = buildLink('l1')
    await repo.insert(link)
    const other = new SqliteAgentLinkRepository(database.open())
    const first = await repo.update({ ...link, roundsUsed: 1, revision: 2 })
    const second = await other.update({ ...link, roundsUsed: 2, revision: 2 })
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, reason: 'revision_conflict' })
    expect((await other.findById('l1'))?.roundsUsed).toBe(1)
  })

  it('lists by orchestrator, activity and project', async () => {
    const a = buildLink('l1', 'exec-a')
    const b = buildLink('l2', 'exec-b', { projectId: 'project-2' })
    await repo.insert(a)
    await repo.insert(b)
    await repo.update(closeLink(b, 'user', new Date()))
    expect((await repo.listActive()).map(item => item.id)).toEqual(['l1'])
    expect((await repo.listActiveByOrchestrator('orch-1')).map(item => item.id)).toEqual(['l1'])
    expect((await repo.listByProject('project-2')).map(item => item.id)).toEqual(['l2'])
    expect((await repo.listByProject(null)).map(item => item.id)).toEqual(['l1', 'l2'])
  })
})
