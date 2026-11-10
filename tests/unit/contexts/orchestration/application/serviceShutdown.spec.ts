import { describe, expect, it } from 'vitest'
import { spawnedHarness, startedEvent } from './fakes'

describe('OrchestrationService.shutdown', () => {
  it('closes the runtime with the shutdown reason and leaves the link active', async () => {
    const { harness, runtime, linkId } = await spawnedHarness()

    await harness.service.shutdown()

    expect(runtime.closes).toEqual(['shutdown'])
    expect((await harness.links.listActive()).map(link => link.id)).toEqual([linkId])
  })

  it('does not mark unavailable, notify the orchestrator or restart the service', async () => {
    const { harness, runtime, executorNodeId } = await spawnedHarness()
    runtime.close = async reason => {
      runtime.closes.push(reason)
      runtime.emit({ type: 'executor.down', reason: 'crashed', exitCode: 1, signal: null })
    }

    await harness.service.shutdown()
    await harness.service.whenIdle()

    expect(harness.service.healthOf(executorNodeId)).not.toBe('unavailable')
    expect(harness.notices.rows).toHaveLength(0)
    expect(harness.starts).toHaveLength(1)
    expect(harness.tuiRelaunches).toEqual([])
  })

  it('waits for the closes in parallel and survives one that fails', async () => {
    const { harness, runtime } = await spawnedHarness()
    runtime.close = async () => {
      throw new Error('close failed')
    }

    await expect(harness.service.shutdown()).resolves.toBeUndefined()
  })

  it('closes a runtime once, however many times it is asked', async () => {
    const { harness, runtime } = await spawnedHarness()

    await harness.service.shutdown()
    await harness.service.shutdown()

    expect(runtime.closes).toEqual(['shutdown'])
  })

  it('ignores events of the runtime after the shutdown', async () => {
    const { harness, runtime, executorNodeId } = await spawnedHarness()
    await harness.service.shutdown()

    runtime.emit(startedEvent('turn-9', 'dispatch-9'))
    await harness.service.whenIdle()

    expect(harness.service.healthOf(executorNodeId)).not.toBe('busy')
  })
})
