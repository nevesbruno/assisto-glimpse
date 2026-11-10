import { describe, expect, it } from 'vitest'
import type { ExecutorHealth } from '../../../../../src/contexts/orchestration/application/executorHealth'
import { completedEvent, startedEvent, spawnedHarness } from './fakes'

function collect(service: {
  subscribeHealth: (l: (id: string, h: ExecutorHealth) => void) => () => void
}) {
  const seen: [string, ExecutorHealth][] = []
  const cancel = service.subscribeHealth((id, health) => seen.push([id, health]))
  return { seen, cancel }
}

describe('subscribeHealth and healthOf', () => {
  it('healthOf reads the derived health, starting for an executor never seen', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    expect(harness.service.healthOf(executorNodeId)).toBe('ready')
    expect(harness.service.healthOf('never-seen')).toBe('starting')
  })

  it('the listener receives only changes of health, with the new value', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    const { seen } = collect(harness.service)
    runtime.emit(startedEvent('t1', null))
    runtime.emit(startedEvent('t2', null))
    runtime.emit(completedEvent('t2', null))
    await harness.service.whenIdle()
    expect(seen).toEqual([
      [executorNodeId, 'busy'],
      [executorNodeId, 'ready'],
    ])
  })

  it('reports unavailable and the return to starting when the service starts again', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    const { seen } = collect(harness.service)
    await harness.service.markExecutorUnavailable(executorNodeId)
    await harness.service.relaunchExecutorTui(executorNodeId)
    expect(seen.map(([, health]) => health)).toEqual(['unavailable', 'starting', 'ready'])
  })

  it('the canceller stops the notifications', async () => {
    const { harness, runtime } = await spawnedHarness()
    const { seen, cancel } = collect(harness.service)
    cancel()
    runtime.emit(startedEvent('t1', null))
    await harness.service.whenIdle()
    expect(seen).toEqual([])
  })
})
