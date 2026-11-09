// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoredNotice } from '../../../../src/contexts/orchestration/application/ports/repositories'
import { SqliteNoticeOutboxRepository } from '../../../../src/contexts/orchestration/infrastructure/persistence/SqliteNoticeOutboxRepository'
import { createTempDatabase, type TempDatabase } from './orchestrationDb'

let database: TempDatabase
let repo: SqliteNoticeOutboxRepository

beforeEach(() => {
  database = createTempDatabase()
  repo = new SqliteNoticeOutboxRepository(database.open())
})

afterEach(() => database.dispose())

function notice(id: string, dedupeKey: string, orchestratorNodeId = 'orch-1'): StoredNotice {
  return {
    id,
    orchestratorNodeId,
    dedupeKey,
    entry: {
      executorNodeId: 'exec-a',
      executorName: 'Codex A',
      provider: 'codex',
      kind: 'completed',
      round: 1,
      roundsLimit: 3,
      dispatchId: 'd1',
      glimpseTurnId: null,
      excerpt: 'done',
      createdAt: '2026-11-09T12:00:00.000Z',
    },
    state: 'pending',
    batchId: null,
    createdAt: '2026-11-09T12:00:00.000Z',
    settledAt: null,
  }
}

describe('SqliteNoticeOutboxRepository', () => {
  it('stores the notice and returns it pending with its entry intact', async () => {
    const stored = notice('n1', 'd1:completed')
    expect(await repo.enqueue(stored)).toEqual({ enqueued: true })
    expect(await repo.listPending('orch-1')).toEqual([stored])
  })

  it('does not create a second notice for a repeated dedupe key', async () => {
    await repo.enqueue(notice('n1', 'd1:completed'))
    expect(await repo.enqueue(notice('n2', 'd1:completed'))).toEqual({ enqueued: false })
    expect((await repo.listPending('orch-1')).map(item => item.id)).toEqual(['n1'])
  })

  it('settles a whole batch with one delivery id', async () => {
    await repo.enqueue(notice('n1', 'k1'))
    await repo.enqueue(notice('n2', 'k2'))
    await repo.enqueue(notice('n3', 'k3'))
    const at = new Date('2026-11-09T12:10:00.000Z')
    await repo.settleBatch(['n1', 'n2'], 'batch-1', 'uncertain', at)
    expect((await repo.listPending('orch-1')).map(item => item.id)).toEqual(['n3'])
    const uncertain = await repo.listUncertain('orch-1')
    expect(uncertain.map(item => [item.id, item.batchId, item.state, item.settledAt])).toEqual([
      ['n1', 'batch-1', 'uncertain', at.toISOString()],
      ['n2', 'batch-1', 'uncertain', at.toISOString()],
    ])
    await repo.settleBatch([], 'batch-2', 'delivered', at)
  })

  it('drops the notices of one orchestrator only', async () => {
    await repo.enqueue(notice('n1', 'k1'))
    await repo.enqueue(notice('n2', 'k2', 'orch-2'))
    await repo.deleteByOrchestrator('orch-1')
    expect(await repo.listPending('orch-1')).toEqual([])
    expect((await repo.listPending('orch-2')).map(item => item.id)).toEqual(['n2'])
  })
})
