import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupervisor } from '../../../../../src/contexts/orchestration/application/supervisor'
import {
  completedEvent,
  orchestratorPrincipal,
  ORCHESTRATOR,
  startedEvent,
  spawnedHarness,
} from './fakes'

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

async function supervised(existing?: Awaited<ReturnType<typeof spawnedHarness>>) {
  const spawned = existing ?? (await spawnedHarness())
  const { harness } = spawned
  const woken: string[] = []
  const supervisor = createSupervisor({
    links: harness.links,
    dispatches: harness.dispatches,
    notices: harness.notices,
    nodes: { findNode: async id => harness.nodes.get(id) as never },
    clock: harness.clock,
    ids: { uuid: () => `n-${harness.notices.rows.length + 1}` },
    schedule,
    onNotice: orchestratorNodeId => woken.push(orchestratorNodeId),
  })
  const cancel = harness.service.subscribeEvents((id, event) => void supervisor.handle(id, event))
  const settle = async () => {
    await harness.service.whenIdle()
    await vi.advanceTimersByTimeAsync(0)
  }
  return { ...spawned, woken, supervisor, cancel, settle }
}

const kinds = (s: Awaited<ReturnType<typeof supervised>>) =>
  s.harness.notices.rows.map(row => row.entry.kind)

describe('supervisor (U-06)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes events to subscribers after handling and stops after the canceller', async () => {
    const s = await supervised()
    const seen: string[] = []
    const cancel = s.harness.service.subscribeEvents((_id, event) => seen.push(event.type))
    s.runtime.emit({
      type: 'approval.requested',
      requestId: 'a1',
      kind: 'x',
      summary: 's',
      turnRef: null,
    })
    await s.settle()
    expect(seen).toEqual(['approval.requested'])
    cancel()
    s.runtime.emit({ type: 'approval.resolved', requestId: 'a1', resolvedBy: 'screen' })
    await s.settle()
    expect(seen).toEqual(['approval.requested'])
  })

  it('notices an unanswered approval at 120 s, once', async () => {
    const s = await supervised()
    s.runtime.emit({
      type: 'approval.requested',
      requestId: 'a1',
      kind: 'x',
      summary: 's',
      turnRef: null,
    })
    await s.settle()
    await vi.advanceTimersByTimeAsync(119_000)
    expect(kinds(s)).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(kinds(s)).toEqual(['approval_unanswered'])
    expect(new Set(s.woken)).toEqual(new Set([ORCHESTRATOR]))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(kinds(s)).toEqual(['approval_unanswered'])
  })

  it('does not notice an approval resolved before 120 s', async () => {
    const s = await supervised()
    s.runtime.emit({
      type: 'approval.requested',
      requestId: 'a1',
      kind: 'x',
      summary: 's',
      turnRef: null,
    })
    await s.settle()
    s.runtime.emit({ type: 'approval.resolved', requestId: 'a1', resolvedBy: 'screen' })
    await s.settle()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(kinds(s)).toEqual([])
  })

  it('notices a down executor once per incident, and the next death after a recovery', async () => {
    const s = await supervised()
    const down = {
      type: 'executor.down',
      reason: 'process_exit',
      exitCode: 1,
      signal: null,
    } as const
    s.runtime.emit(down)
    await s.settle()
    s.runtime.emit({
      type: 'executor.down',
      reason: 'restarts_exhausted',
      exitCode: null,
      signal: null,
    })
    await s.settle()
    expect(kinds(s)).toEqual(['executor_down'])
    s.runtime.emit({ type: 'executor.recovered', sessionRef: 's' })
    await s.settle()
    s.runtime.emit(down)
    await s.settle()
    expect(kinds(s)).toEqual(['executor_down', 'executor_down'])
  })

  it('notices a death that arrives before the previous recovery, one notice per incident', async () => {
    const s = await supervised()
    const died = async () => {
      s.runtime.emit({ type: 'executor.down', reason: 'process_exit', exitCode: 1, signal: null })
      await s.settle()
    }
    const recovered = async () => {
      s.runtime.emit({ type: 'executor.recovered', sessionRef: 's' })
      await s.settle()
    }
    await died()
    await recovered()
    await died()
    await recovered()
    await died()
    await died()
    s.runtime.emit({
      type: 'executor.down',
      reason: 'restarts_exhausted',
      exitCode: null,
      signal: null,
    })
    await s.settle()
    expect(kinds(s)).toEqual(['executor_down', 'executor_down', 'executor_down', 'executor_down'])
  })

  it('does not reuse the death key of a previous supervisor over the same outbox', async () => {
    const first = await supervised()
    first.runtime.emit({
      type: 'executor.down',
      reason: 'process_exit',
      exitCode: 1,
      signal: null,
    })
    await first.settle()
    expect(kinds(first)).toEqual(['executor_down'])
    first.cancel()
    const second = await supervised(first)
    second.runtime.emit({
      type: 'executor.down',
      reason: 'process_exit',
      exitCode: 1,
      signal: null,
    })
    await second.settle()
    expect(kinds(second)).toEqual(['executor_down', 'executor_down'])
  })

  it('notices a dispatch past its deadline once, and not after it completed', async () => {
    const s = await supervised()
    const { harness, runtime, executorNodeId } = s
    const sent = await harness.service.dispatch(orchestratorPrincipal(), {
      dispatchId: '33333333-3333-4333-8333-333333333331',
      to: executorNodeId,
      text: 'work',
      deadlineMs: 60_000,
    })
    await s.settle()
    runtime.emit(startedEvent('turn-1', sent.dispatchId))
    await s.settle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(kinds(s)).toEqual(['deadline_exceeded'])
    runtime.emit(completedEvent('turn-1', sent.dispatchId))
    await s.settle()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(kinds(s)).toEqual(['deadline_exceeded', 'completed'])
  })

  it('wakes the pump for the orchestrator after every event of a linked executor', async () => {
    const s = await supervised()
    s.runtime.emit(completedEvent('turn-9', null))
    await s.settle()
    expect(s.woken).toContain(ORCHESTRATOR)
  })

  it('drops the repeated notice of the same key', async () => {
    const s = await supervised()
    s.runtime.emit({
      type: 'approval.requested',
      requestId: 'a1',
      kind: 'x',
      summary: 's',
      turnRef: null,
    })
    s.runtime.emit({
      type: 'approval.requested',
      requestId: 'a1',
      kind: 'x',
      summary: 's',
      turnRef: null,
    })
    await s.settle()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(kinds(s)).toEqual(['approval_unanswered'])
  })
})
