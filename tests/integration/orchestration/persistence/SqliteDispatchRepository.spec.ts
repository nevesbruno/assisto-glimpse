// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  transitionDispatch,
  type DispatchEvent,
} from '../../../../src/contexts/orchestration/domain/dispatch'
import { SqliteDispatchRepository } from '../../../../src/contexts/orchestration/infrastructure/persistence/SqliteDispatchRepository'
import { buildDispatch, buildLink, createTempDatabase, type TempDatabase } from './orchestrationDb'

let database: TempDatabase
let repo: SqliteDispatchRepository
const link = buildLink('l1', 'exec-a')
const now = new Date('2026-11-09T12:05:00.000Z')

const reserve: DispatchEvent = { type: 'reserve', now }
const accepted: DispatchEvent = { type: 'service_accepted', turnRef: 't1', now }
const finished: DispatchEvent = {
  type: 'turn_finished',
  outcome: 'completed',
  finalExcerpt: null,
  finalChars: null,
  now,
}

beforeEach(() => {
  database = createTempDatabase()
  repo = new SqliteDispatchRepository(database.open())
})

afterEach(() => database.dispose())

async function advance(id: string, events: readonly DispatchEvent[]) {
  let current = (await repo.findById(id))!
  for (const event of events) {
    current = transitionDispatch(current, event).dispatch
    // oxlint-disable-next-line no-await-in-loop -- transitions are order dependent
    expect((await repo.update(current)).ok).toBe(true)
  }
  return current
}

describe('SqliteDispatchRepository, I-08', () => {
  it('refuses the second queued dispatch of the executor and writes nothing', async () => {
    const first = buildDispatch('d1', link)
    expect(await repo.insert(first)).toEqual({ ok: true, value: first })
    expect(await repo.insert(buildDispatch('d2', link, 1))).toEqual({
      ok: false,
      reason: 'executor_busy',
    })
    expect(await repo.findById('d2')).toBeNull()
    expect((await repo.findNonFinalByExecutor('exec-a'))?.id).toBe('d1')
    expect((await repo.findOldestQueuedByExecutor('exec-a'))?.id).toBe('d1')
  })

  it.each([
    ['reserved', [reserve]],
    ['sent', [reserve, accepted]],
    ['uncertain', [reserve, { type: 'send_uncertain', now } as DispatchEvent]],
  ])('refuses a new dispatch while the first is %s', async (state, events) => {
    await repo.insert(buildDispatch('d1', link))
    await advance('d1', events)
    expect((await repo.findNonFinalByExecutor('exec-a'))?.state).toBe(state)
    expect(await repo.insert(buildDispatch('d2', link, 1))).toEqual({
      ok: false,
      reason: 'executor_busy',
    })
    expect(await repo.findById('d2')).toBeNull()
  })

  it('accepts one dispatch per executor', async () => {
    const other = buildLink('l2', 'exec-b')
    expect((await repo.insert(buildDispatch('d1', link))).ok).toBe(true)
    expect((await repo.insert(buildDispatch('d2', other))).ok).toBe(true)
  })

  it.each([
    ['completed', [reserve, accepted, finished]],
    ['failed', [reserve, { type: 'service_rejected', now } as DispatchEvent]],
    ['cancelled', [{ type: 'cancel', now } as DispatchEvent]],
  ])('accepts another dispatch after %s', async (state, events) => {
    await repo.insert(buildDispatch('d1', link))
    expect((await advance('d1', events)).state).toBe(state)
    expect(await repo.findNonFinalByExecutor('exec-a')).toBeNull()
    expect((await repo.insert(buildDispatch('d2', link, 1))).ok).toBe(true)
  })

  it('writes exactly one of two simultaneous inserts from two connections', async () => {
    const other = new SqliteDispatchRepository(database.open())
    const results = await Promise.all([
      repo.insert(buildDispatch('d1', link)),
      other.insert(buildDispatch('d2', link, 1)),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'executor_busy' }])
    expect(await repo.listByStates(['queued'])).toHaveLength(1)
  })

  it('answers id_exists for a repeated id', async () => {
    await repo.insert(buildDispatch('d1', link))
    expect(await repo.insert(buildDispatch('d1', link))).toEqual({ ok: false, reason: 'id_exists' })
  })
})

describe('SqliteDispatchRepository, CAS and visibility', () => {
  it('makes the reservation visible to a second connection when update returns (D2)', async () => {
    await repo.insert(buildDispatch('d1', link))
    await advance('d1', [reserve])
    const reader = new SqliteDispatchRepository(database.open())
    const seen = await reader.findInFlightByExecutor('exec-a')
    expect(seen?.state).toBe('reserved')
    expect(seen?.reservedAt).toBe(now.toISOString())
    expect(await reader.findOldestQueuedByExecutor('exec-a')).toBeNull()
  })

  it('answers revision_conflict for a stale revision without writing', async () => {
    const queued = buildDispatch('d1', link)
    await repo.insert(queued)
    const reserved = transitionDispatch(queued, reserve).dispatch
    await repo.update(reserved)
    const stale = transitionDispatch(queued, { type: 'cancel', now }).dispatch
    expect(await repo.update(stale)).toEqual({ ok: false, reason: 'revision_conflict' })
    expect(await repo.findById('d1')).toEqual(reserved)
    expect(await repo.update({ ...queued, id: 'ghost', revision: 2 })).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('keeps the text of a final dispatch cleared and lists by link and states', async () => {
    await repo.insert(buildDispatch('d1', link))
    await advance('d1', [{ type: 'cancel', now }])
    expect((await repo.findById('d1'))?.text).toBeNull()
    expect((await repo.listByLink('l1')).map(item => item.id)).toEqual(['d1'])
    expect((await repo.listByStates(['cancelled'])).map(item => item.id)).toEqual(['d1'])
    expect(await repo.listByStates([])).toEqual([])
  })

  it('refuses to reserve while another dispatch of the executor is in flight', async () => {
    await repo.insert(buildDispatch('d1', link))
    await advance('d1', [reserve])
    const intruder = transitionDispatch(buildDispatch('d2', link, 1), reserve).dispatch
    expect(await repo.update(intruder)).toEqual({ ok: false, reason: 'in_flight_conflict' })
  })
})
