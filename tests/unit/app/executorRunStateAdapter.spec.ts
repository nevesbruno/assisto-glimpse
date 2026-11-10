import { describe, expect, it } from 'vitest'
import { AGENT_HOOK_FRESHNESS_MS } from '../../../src/contexts/agent/domain/agentRunStateArbiter'
import { AgentRunStateRegistry } from '../../../src/contexts/agent/application/AgentRunStateRegistry'
import {
  createExecutorRunStateAdapter,
  type LiveExecutorSession,
} from '../../../src/app/main/controlSurface/orchestration/executorRunStateAdapter'
import { EXECUTOR_LEASE_RENEWAL_MS } from '../../../src/app/main/controlSurface/orchestration/executorRunStateIngress'

const NODE = 'node-1'

function fixture() {
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
  let live: LiveExecutorSession | null = { sessionId: 's1', provider: 'codex', incarnation: 'i1' }
  const logs: string[] = []
  const adapter = createExecutorRunStateAdapter({
    registry,
    liveSessionOf: () => live,
    now: () => now,
    schedule,
    log: message => void logs.push(message),
  })
  const tick = (ms: number) => {
    now += ms
  }
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
  return {
    adapter,
    registry,
    logs,
    tick,
    advance,
    setLive: (next: LiveExecutorSession | null) => void (live = next),
    state: (sessionId = 's1') => registry.get({ sessionId })?.state,
  }
}

const start = { executorNodeId: NODE, turnRef: 't1', origin: 'glimpse' as const, text: null }
const complete = (glimpseTurnId: string, finalMessage: string | null = 'done') => ({
  executorNodeId: NODE,
  turnRef: 't1',
  glimpseTurnId,
  outcome: 'completed' as const,
  finalMessage,
})

describe('executor run state adapter', () => {
  it('start returns the registry turn id and the session is working', async () => {
    const f = fixture()
    const { glimpseTurnId } = await f.adapter.recordTurnStarted(start)
    expect(glimpseTurnId).toBe('turn-1')
    expect(f.state()).toBe('working')
  })

  it('approval requested then resolved goes waiting then working', async () => {
    const f = fixture()
    await f.adapter.recordTurnStarted(start)
    f.tick(5)
    await f.adapter.recordWaitingForApproval(NODE, 'req-1', 'rm -rf build')
    expect(f.state()).toBe('waiting')
    expect(f.registry.get({ sessionId: 's1' })?.blockedSummary).toBe('rm -rf build')
    f.tick(5)
    await f.adapter.recordApprovalResolved(NODE, 'req-1')
    expect(f.state()).toBe('working')
  })

  it('end archives the final message readable by turn id and goes idle', async () => {
    const f = fixture()
    const { glimpseTurnId } = await f.adapter.recordTurnStarted(start)
    f.tick(5)
    await f.adapter.recordTurnCompleted(complete(glimpseTurnId, 'hello'))
    expect(f.state()).toBe('idle')
    expect(f.registry.finalMessage({ sessionId: 's1', turnId: glimpseTurnId })).toMatchObject({
      message: 'hello',
      truncated: false,
    })
  })

  it('truncates a final message above 64 KiB', async () => {
    const f = fixture()
    const { glimpseTurnId } = await f.adapter.recordTurnStarted(start)
    f.tick(5)
    await f.adapter.recordTurnCompleted(complete(glimpseTurnId, 'a'.repeat(64 * 1024 + 10)))
    const read = f.registry.finalMessage({ sessionId: 's1', turnId: glimpseTurnId })
    expect(read.message.length).toBe(64 * 1024)
    expect(read.truncated).toBe(true)
  })

  it('renews the lease while working', async () => {
    const f = fixture()
    await f.adapter.recordTurnStarted(start)
    const before = f.registry.get({ sessionId: 's1' })!.lastTransitionAt
    f.advance(EXECUTOR_LEASE_RENEWAL_MS * 2)
    expect(f.state()).toBe('working')
    expect(AGENT_HOOK_FRESHNESS_MS).toBeGreaterThan(EXECUTOR_LEASE_RENEWAL_MS)
    expect(f.registry.get({ sessionId: 's1' })!.lastTransitionAt).toBeGreaterThanOrEqual(before)
  })

  it('executor down leaves the state unknown', async () => {
    const f = fixture()
    await f.adapter.recordTurnStarted(start)
    f.tick(5)
    await f.adapter.recordExecutorDown(NODE)
    expect(f.state()).toBe('unknown')
  })

  it('executor recovered leaves unknown and returns to the working state', async () => {
    const f = fixture()
    await f.adapter.recordTurnStarted(start)
    f.tick(5)
    await f.adapter.recordExecutorDown(NODE)
    expect(f.state()).toBe('unknown')
    f.tick(5)
    await f.adapter.recordExecutorRecovered(NODE)
    expect(f.state()).toBe('working')
  })

  it('executor recovered without a prior down keeps the state', async () => {
    const f = fixture()
    await f.adapter.recordTurnStarted(start)
    f.tick(5)
    await f.adapter.recordExecutorRecovered(NODE)
    expect(f.state()).toBe('working')
  })

  it('records without a live session are reported, never dropped silently', async () => {
    const f = fixture()
    f.setLive(null)
    await expect(f.adapter.recordTurnStarted(start)).rejects.toThrow(/No live session/)
    await expect(f.adapter.recordTurnCompleted(complete('turn-x'))).rejects.toThrow(
      /No live session/,
    )
    await f.adapter.recordWaitingForApproval(NODE, 'r', 'summary')
    await f.adapter.recordApprovalResolved(NODE, 'r')
    await f.adapter.recordExecutorDown(NODE)
    await f.adapter.recordExecutorRecovered(NODE)
    expect(f.logs).toHaveLength(4)
  })

  it('a replaced session closes the old one and binds the new one', async () => {
    const f = fixture()
    await f.adapter.recordTurnStarted(start)
    f.tick(5)
    f.setLive({ sessionId: 's2', provider: 'codex', incarnation: 'i2' })
    const { glimpseTurnId } = await f.adapter.recordTurnStarted(start)
    expect(f.state('s1')).toBe('exited')
    expect(f.state('s2')).toBe('working')
    expect(glimpseTurnId).toBe('turn-2')
  })

  it('dispose closes the sessions and cancels renewal', async () => {
    const f = fixture()
    await f.adapter.recordTurnStarted(start)
    f.tick(5)
    f.adapter.dispose()
    expect(f.state()).toBe('exited')
    f.advance(EXECUTOR_LEASE_RENEWAL_MS * 3)
    expect(f.state()).toBe('exited')
  })
})
