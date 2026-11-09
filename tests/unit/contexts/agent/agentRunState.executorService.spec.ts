import { describe, expect, it } from 'vitest'
import { AGENT_HOOK_FRESHNESS_MS } from '../../../../src/contexts/agent/domain/agentRunStateArbiter'
import {
  AgentRunStateRegistry,
  type AgentRuntimeEvent,
} from '../../../../src/contexts/agent/application/AgentRunStateRegistry'
import {
  EXECUTOR_LEASE_RENEWAL_MS,
  ExecutorRunStateIngress,
} from '../../../../src/app/main/controlSurface/orchestration/executorRunStateIngress'
import type { ExecutorRuntimeEvent } from '../../../../src/contexts/orchestration/application/ports/executorRuntime'

function fixture(options: { renew?: boolean } = {}) {
  let now = 1_000
  let id = 0
  const timers = new Map<() => void, number>()
  const schedule = (callback: () => void, delay: number) => {
    timers.set(callback, now + delay)
    return () => void timers.delete(callback)
  }
  const registry = new AgentRunStateRegistry({
    epoch: 'w',
    now: () => now,
    createTurnId: () => `turn-${++id}`,
    schedule,
  })
  const events: AgentRuntimeEvent[] = []
  registry.subscribe({ epoch: 'w', afterSeq: 0 }, {}, event => {
    if (event.type !== 'resync_required') {
      events.push(event)
    }
  })
  const ingress = new ExecutorRunStateIngress(
    {
      registry,
      now: () => now,
      schedule: options.renew === false ? () => () => undefined : schedule,
    },
    { sessionId: 's', executorNodeId: 'n', provider: 'codex', incarnation: 'i' },
  )
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers].filter(([, at]) => at <= target).sort((a, b) => a[1] - b[1])[0]
      if (!due) {
        break
      }
      now = Math.max(now, due[1])
      timers.delete(due[0])
      due[0]()
    }
    now = target
  }
  const send = (event: ExecutorRuntimeEvent) => {
    now += 5
    ingress.handle(event)
  }
  return { registry, ingress, send, advance, events, get: () => registry.get({ sessionId: 's' })! }
}

const started: ExecutorRuntimeEvent = {
  type: 'turn.started',
  turnRef: 't1',
  dispatchId: null,
  origin: 'glimpse',
}
const completed = (outcome: 'completed' | 'failed' | 'interrupted' = 'completed') =>
  ({
    type: 'turn.completed',
    turnRef: 't1',
    dispatchId: null,
    outcome,
    finalMessage: 'done',
    usage: null,
  }) as const

describe('executor_service run state source', () => {
  it('walks working, waiting and idle with the new source and authoritative quality', () => {
    const f = fixture()
    f.send({ type: 'executor.ready', sessionRef: 'r', resumed: false, version: '1' })
    expect(f.get()).toMatchObject({ state: 'idle', source: 'executor_service', turn: null })

    f.send(started)
    expect(f.get()).toMatchObject({
      state: 'working',
      source: 'executor_service',
      quality: 'authoritative',
    })
    const turnId = f.get().turn!.id

    f.send({
      type: 'approval.requested',
      requestId: 'a1',
      kind: 'exec',
      summary: 's',
      turnRef: 't1',
    })
    expect(f.get()).toMatchObject({ state: 'waiting', blockedReason: 'permission' })
    expect(f.get().turn!.id).toBe(turnId)

    f.send({ type: 'approval.resolved', requestId: 'a1', resolvedBy: 'glimpse' })
    expect(f.get()).toMatchObject({ state: 'working', blockedReason: null })

    f.send(completed())
    expect(f.get()).toMatchObject({
      state: 'idle',
      turn: null,
      turnOutcome: 'completed',
      lastEndedTurn: { id: turnId, outcome: 'completed' },
    })
    expect(f.events.filter(e => e.type === 'agent.turn_completed')).toHaveLength(1)
  })

  it('maps interrupted to aborted and failed to failed', () => {
    const f = fixture()
    f.send(started)
    f.send(completed('interrupted'))
    expect(f.get().turnOutcome).toBe('aborted')
    f.send(started)
    f.send(completed('failed'))
    expect(f.get().turnOutcome).toBe('failed')
  })

  it('I2: an idle baseline cannot manufacture a completed turn', () => {
    const f = fixture()
    f.send({ type: 'executor.ready', sessionRef: 'r', resumed: false, version: '1' })
    f.send({ type: 'executor.recovered', sessionRef: 'r' })
    expect(f.events.some(e => e.type === 'agent.turn_completed')).toBe(false)
    expect(f.get().lastEndedTurn).toBeNull()
  })

  it('I3: degraded and down never become idle, and recovery restores the prior state', () => {
    const f = fixture()
    f.send(started)
    f.send({ type: 'executor.degraded', reason: 'x' })
    expect(f.get()).toMatchObject({ state: 'unknown', quality: 'degraded' })
    f.send({ type: 'executor.recovered', sessionRef: 'r' })
    expect(f.get()).toMatchObject({ state: 'working' })
    f.send({ type: 'executor.down', reason: 'x', exitCode: 1, signal: null })
    expect(f.get().state).toBe('unknown')
  })

  it('renewal every 60 s keeps the 180 s lease alive', () => {
    const f = fixture()
    f.send(started)
    f.advance(AGENT_HOOK_FRESHNESS_MS * 3)
    expect(EXECUTOR_LEASE_RENEWAL_MS).toBeLessThan(AGENT_HOOK_FRESHNESS_MS)
    expect(f.get()).toMatchObject({ state: 'working', quality: 'authoritative' })
  })

  it('without renewal the lease expires into unknown, never idle (I3)', () => {
    const f = fixture({ renew: false })
    f.send(started)
    f.advance(AGENT_HOOK_FRESHNESS_MS - 1_000)
    expect(f.get().state).toBe('working')
    f.advance(2_000)
    expect(f.get()).toMatchObject({ state: 'unknown', quality: 'degraded' })
  })

  it('completion stops renewal and close exits the session', () => {
    const f = fixture()
    f.send(started)
    f.send(completed())
    f.advance(AGENT_HOOK_FRESHNESS_MS * 2)
    expect(f.get().state).toBe('idle')
    f.ingress.close()
    expect(f.get().state).toBe('exited')
  })

  it('keeps the final message for an exact turn read (up to 64 KiB)', () => {
    const f = fixture()
    f.send(started)
    const turnId = f.get().turn!.id
    f.send({ ...completed(), finalMessage: 'x'.repeat(70 * 1024) })
    const read = f.registry.finalMessage({ sessionId: 's', turnId })
    expect(read).toMatchObject({ turnId, outcome: 'completed', truncated: true })
    expect(Buffer.byteLength(read.message, 'utf8')).toBe(64 * 1024)
    f.send(started)
    const second = f.get().turn!.id
    f.send(completed())
    expect(f.registry.finalMessage({ sessionId: 's', turnId: second })).toMatchObject({
      message: 'done',
      truncated: false,
    })
  })
})
