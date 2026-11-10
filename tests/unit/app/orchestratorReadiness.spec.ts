import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestratorReadiness } from '../../../src/app/main/controlSurface/orchestration/orchestratorReadiness'
import type { AgentRunSnapshot } from '../../../src/contexts/agent/domain/agentRunState'
import type { OrchestratorReadiness } from '../../../src/contexts/orchestration/application/ports'

const NODE = 'orq'

function setup(overrides: Partial<AgentRunSnapshot> = {}) {
  const snapshot: AgentRunSnapshot = {
    sessionId: 'sess',
    nodeId: NODE,
    provider: 'codex',
    state: 'idle',
    blockedReason: null,
    turn: null,
    lastTransitionAt: 0,
    source: 'codex_hook',
    quality: 'authoritative',
    turnOutcome: null,
    lastEndedTurn: null,
    ...overrides,
  }
  const env = {
    snapshot: snapshot as AgentRunSnapshot | null,
    now: 100_000,
    typedAt: null as number | null,
    inFlight: false,
  }
  const subscriptions: { filter: unknown; notify: () => void; cancelled: boolean }[] = []
  const schedules: number[] = []
  const readiness = createOrchestratorReadiness({
    registry: {
      get: () => env.snapshot,
      list: () => ({ epoch: 'e', seq: 7 }),
      subscribe: (cursor, filter, listener) => {
        const sub = {
          filter: { cursor, filter },
          notify: () => listener({} as never),
          cancelled: false,
        }
        subscriptions.push(sub)
        return () => {
          sub.cancelled = true
        }
      },
    },
    inputWatermark: () => env.typedAt,
    deliveryInFlight: () => env.inFlight,
    now: () => env.now,
    schedule: (callback, delayMs) => {
      schedules.push(delayMs)
      const timer = setTimeout(() => {
        env.now += delayMs
        callback()
      }, delayMs)
      return () => clearTimeout(timer)
    },
  })
  return { readiness, env, subscriptions, schedules }
}

const reason = (value: OrchestratorReadiness) => (value.idle ? null : value.reason)

describe('orchestrator readiness (U-06)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is idle only with an idle, authoritative run state, no delivery, no typing and no approval', async () => {
    const { readiness, env } = setup()
    expect(await readiness.readReadiness(NODE)).toEqual({ idle: true })
    env.snapshot = { ...env.snapshot!, state: 'working' }
    expect(reason(await readiness.readReadiness(NODE))).toBe('running')
    env.snapshot = { ...env.snapshot, state: 'waiting', blockedReason: 'permission' }
    expect(reason(await readiness.readReadiness(NODE))).toBe('approval_open')
    env.snapshot = { ...env.snapshot, state: 'idle', quality: 'degraded' }
    expect(reason(await readiness.readReadiness(NODE))).toBe('hook_stale')
    env.snapshot = { ...env.snapshot, quality: 'authoritative' }
    env.inFlight = true
    expect(reason(await readiness.readReadiness(NODE))).toBe('delivery_in_flight')
    env.inFlight = false
    env.typedAt = env.now - 9_999
    expect(reason(await readiness.readReadiness(NODE))).toBe('typing')
    env.typedAt = env.now - 10_000
    expect(await readiness.readReadiness(NODE)).toEqual({ idle: true })
  })

  it('treats a node without run state as not ready', async () => {
    const { readiness, env } = setup()
    env.snapshot = null
    expect(reason(await readiness.readReadiness(NODE))).toBe('hook_stale')
  })

  it('subscribes the registry filtered by node and idle state, and cancels it', () => {
    const { readiness, subscriptions } = setup()
    const cancel = readiness.watchReadiness(NODE, () => undefined)
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0].filter).toEqual({
      cursor: { epoch: 'e', afterSeq: 7 },
      filter: { nodeId: NODE, state: 'idle' },
    })
    cancel()
    expect(subscriptions[0].cancelled).toBe(true)
  })

  it('notifies when the registry makes the node idle', () => {
    const { readiness, env, subscriptions } = setup({ state: 'working' })
    const seen: OrchestratorReadiness[] = []
    readiness.watchReadiness(NODE, value => seen.push(value))
    env.snapshot = { ...env.snapshot!, state: 'idle' }
    subscriptions[0].notify()
    expect(seen).toEqual([{ idle: true }])
  })

  it('chama o ouvinte em idle mesmo assinado com o orquestrador já idle', () => {
    const { readiness, env, subscriptions } = setup()
    const seen: OrchestratorReadiness[] = []
    readiness.watchReadiness(NODE, value => seen.push(value))
    env.snapshot = { ...env.snapshot!, state: 'working' }
    env.snapshot = { ...env.snapshot, state: 'idle' }
    subscriptions[0].notify()
    expect(seen).toEqual([{ idle: true }])
  })

  it('expires the 10 s typing window with a single timer and no registry event', async () => {
    const { readiness, env, schedules } = setup()
    env.typedAt = env.now - 4_000
    const seen: OrchestratorReadiness[] = []
    readiness.watchReadiness(NODE, value => seen.push(value))
    expect(schedules).toEqual([6_000])
    await vi.advanceTimersByTimeAsync(5_999)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual([{ idle: true }])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(schedules).toEqual([6_000])
  })

  it('cancels the typing timer with the watcher', async () => {
    const { readiness, env } = setup()
    env.typedAt = env.now - 4_000
    const seen: OrchestratorReadiness[] = []
    const cancel = readiness.watchReadiness(NODE, value => seen.push(value))
    cancel()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(seen).toEqual([])
  })
})
