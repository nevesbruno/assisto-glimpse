import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoticePump } from '../../../../../src/contexts/orchestration/application/noticePump'
import type {
  OrchestratorDeliveryResult,
  OrchestratorReadiness,
  StoredNotice,
} from '../../../../../src/contexts/orchestration/application/ports'

const ORQ = 'orq'

function notice(id: string, kind: StoredNotice['entry']['kind'] = 'completed'): StoredNotice {
  return {
    id,
    orchestratorNodeId: ORQ,
    dedupeKey: id,
    state: 'pending',
    batchId: null,
    createdAt: '2026-11-10T10:00:00.000Z',
    settledAt: null,
    entry: {
      executorNodeId: `exec-${id}`,
      executorName: `name-${id}`,
      provider: 'codex',
      kind,
      round: 1,
      roundsLimit: 3,
      dispatchId: '7f3a0000-0000-4000-8000-000000000000',
      glimpseTurnId: 't1',
      excerpt: null,
      createdAt: '2026-11-10T10:00:00.000Z',
    },
  }
}

function setup(initial: OrchestratorReadiness = { idle: true }) {
  const state = { readiness: initial, result: 'delivered' as OrchestratorDeliveryResult | Error }
  const rows: StoredNotice[] = []
  const settles: { ids: readonly string[]; batchId: string; state: string }[] = []
  const deliveries: { deliveryId: string; text: string }[] = []
  const listeners = new Set<(readiness: OrchestratorReadiness) => void>()
  let reads = 0
  let resolveDelivery: (() => void) | null = null
  const hold = { on: false }
  const pump = createNoticePump({
    notices: {
      listPending: async () => rows.filter(row => row.state === 'pending'),
      settleBatch: async (ids, batchId, next) => {
        settles.push({ ids, batchId, state: next })
        for (const row of rows) {
          if (ids.includes(row.id)) {
            Object.assign(row, { state: next })
          }
        }
      },
    },
    delivery: {
      deliver: async input => {
        deliveries.push({ deliveryId: input.deliveryId, text: input.text })
        if (hold.on) {
          await new Promise<void>(resolve => (resolveDelivery = resolve))
        }
        if (state.result instanceof Error) {
          throw state.result
        }
        return state.result
      },
    },
    readiness: {
      readReadiness: async () => {
        reads += 1
        return state.readiness
      },
      watchReadiness: (_id, listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    clock: { now: () => new Date('2026-11-10T10:00:05.000Z') },
    ids: { uuid: () => `batch-${deliveries.length + 1}` },
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
  })
  const becomeIdle = () => {
    state.readiness = { idle: true }
    for (const listener of [...listeners]) {
      listener(state.readiness)
    }
  }
  return {
    pump,
    state,
    rows,
    settles,
    deliveries,
    listeners,
    hold,
    becomeIdle,
    reads: () => reads,
    releaseDelivery: () => resolveDelivery?.(),
  }
}

describe('notice pump (U-06)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('joins events of a 2 s window into one delivery with the batch id', async () => {
    const t = setup()
    t.rows.push(notice('a'))
    t.pump.poke(ORQ)
    await vi.advanceTimersByTimeAsync(1_000)
    t.rows.push(notice('b'))
    t.pump.poke(ORQ)
    await vi.advanceTimersByTimeAsync(999)
    expect(t.deliveries).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(t.deliveries).toHaveLength(1)
    expect(t.deliveries[0].text).toContain('2 executores com novidade')
    expect(t.deliveries[0].text).toContain('(livre)')
    expect(t.settles).toEqual([
      { ids: ['a', 'b'], batchId: t.deliveries[0].deliveryId, state: 'delivered' },
    ])
  })

  it('does not deliver while busy and wakes by watchReadiness, with no polling', async () => {
    const t = setup({ idle: false, reason: 'running' })
    t.rows.push(notice('a'))
    t.pump.poke(ORQ)
    await vi.advanceTimersByTimeAsync(2_000)
    const readsAfterWindow = t.reads()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(t.deliveries).toEqual([])
    expect(t.reads()).toBe(readsAfterWindow)
    expect(t.listeners.size).toBe(1)
    t.becomeIdle()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.deliveries).toHaveLength(1)
    expect(t.listeners.size).toBe(0)
  })

  it('keeps the batch when the delivery is refused by occupation and wakes on the next idle', async () => {
    const t = setup()
    t.state.result = 'refused_busy'
    t.rows.push(notice('a'))
    t.pump.poke(ORQ)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.deliveries).toHaveLength(1)
    expect(t.settles).toEqual([])
    expect(t.rows[0].state).toBe('pending')
    t.state.readiness = { idle: false, reason: 'typing' }
    t.state.result = 'delivered'
    t.becomeIdle()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.deliveries).toHaveLength(2)
    expect(t.settles.map(s => s.state)).toEqual(['delivered'])
  })

  it.each([
    ['uncertain result', 'uncertain' as const],
    ['thrown error', new Error('stuck')],
  ])('marks the batch uncertain without resend on %s', async (_label, result) => {
    const t = setup()
    t.state.result = result
    t.rows.push(notice('a'))
    t.pump.poke(ORQ)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.settles.map(s => s.state)).toEqual(['uncertain'])
    await vi.advanceTimersByTimeAsync(600_000)
    t.pump.poke(ORQ)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.deliveries).toHaveLength(1)
  })

  it('sends a notice that arrives during a delivery in the next batch', async () => {
    const t = setup()
    t.hold.on = true
    t.rows.push(notice('a'))
    t.pump.poke(ORQ)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.deliveries).toHaveLength(1)
    t.rows.push(notice('b'))
    t.pump.poke(ORQ)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.deliveries).toHaveLength(1)
    t.hold.on = false
    t.releaseDelivery()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.deliveries).toHaveLength(2)
    expect(t.settles.map(s => s.ids)).toEqual([['a'], ['b']])
  })
})
