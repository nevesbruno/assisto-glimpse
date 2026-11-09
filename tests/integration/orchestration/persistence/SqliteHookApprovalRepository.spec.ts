// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HookApproval } from '../../../../src/contexts/orchestration/application/ports/repositories'
import { SqliteHookApprovalRepository } from '../../../../src/contexts/orchestration/infrastructure/persistence/SqliteHookApprovalRepository'
import { createTempDatabase, type TempDatabase } from './orchestrationDb'

let database: TempDatabase
let repo: SqliteHookApprovalRepository

beforeEach(() => {
  database = createTempDatabase()
  repo = new SqliteHookApprovalRepository(database.open())
})

afterEach(() => database.dispose())

function approval(key: string, currentHash: string, approvedBy = 'user-1'): HookApproval {
  return {
    key,
    currentHash,
    eventName: 'PreToolUse',
    sourcePath: `/project/.codex/${key}.json`,
    approvedAt: '2026-11-09T12:00:00.000Z',
    approvedBy,
  }
}

describe('SqliteHookApprovalRepository', () => {
  it('records approvals and finds them by the exact key and hash pair', async () => {
    const a = approval('hook-a', 'h1')
    await repo.record([a, approval('hook-b', 'h2')])
    expect(await repo.findApproved([{ key: 'hook-a', currentHash: 'h1' }])).toEqual([a])
  })

  it('does not match a different hash for the same key', async () => {
    await repo.record([approval('hook-a', 'h1')])
    expect(await repo.findApproved([{ key: 'hook-a', currentHash: 'h2' }])).toEqual([])
  })

  it('keeps the original approvedAt and approvedBy when the pair is recorded again', async () => {
    const original = approval('hook-a', 'h1')
    await repo.record([original])
    await repo.record([
      { ...original, approvedAt: '2027-01-01T00:00:00.000Z', approvedBy: 'user-2' },
    ])
    expect(await repo.findApproved([{ key: 'hook-a', currentHash: 'h1' }])).toEqual([original])
  })

  it('keeps both hashes of a key as separate approvals', async () => {
    await repo.record([approval('hook-a', 'h1'), approval('hook-a', 'h2')])
    const found = await repo.findApproved([
      { key: 'hook-a', currentHash: 'h1' },
      { key: 'hook-a', currentHash: 'h2' },
    ])
    expect(found.map(item => item.currentHash).sort()).toEqual(['h1', 'h2'])
  })

  it('handles empty input and more pairs than one batch', async () => {
    await repo.record([])
    expect(await repo.findApproved([])).toEqual([])
    const many = Array.from({ length: 1200 }, (_, index) => approval(`hook-${index}`, `h${index}`))
    await repo.record(many)
    const found = await repo.findApproved(
      many.map(({ key, currentHash }) => ({ key, currentHash })),
    )
    expect(found).toHaveLength(1200)
  })
})
