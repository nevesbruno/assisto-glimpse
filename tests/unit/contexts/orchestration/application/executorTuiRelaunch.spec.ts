import { describe, expect, it } from 'vitest'
import { codedError, spawnedHarness } from './fakes'

describe('relaunchExecutorTui', () => {
  it('relaunches the TUI of a linked executor whose service is up, without restarting it', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await expect(harness.service.relaunchExecutorTui(executorNodeId)).resolves.toBe(true)
    expect(harness.tuiRelaunches).toEqual([executorNodeId])
    expect(harness.starts).toHaveLength(1)
  })

  it('restarts a fallen service before relaunching', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await harness.service.markExecutorUnavailable(executorNodeId)
    await expect(harness.service.relaunchExecutorTui(executorNodeId)).resolves.toBe(true)
    expect(harness.starts).toHaveLength(2)
    expect(harness.tuiRelaunches).toEqual([executorNodeId])
    expect(harness.service.healthOf(executorNodeId)).toBe('ready')
  })

  it('starts the service of a link whose Worker just booted, before relaunching', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    const service = harness.restart()
    await expect(service.relaunchExecutorTui(executorNodeId)).resolves.toBe(true)
    expect(harness.starts).toHaveLength(2)
    expect(harness.tuiRelaunches).toEqual([executorNodeId])
  })

  it('a restart that fails marks the executor unavailable and does not relaunch', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await harness.service.markExecutorUnavailable(executorNodeId)
    harness.failNextStart.error = codedError('executor.start_failed')
    await expect(harness.service.relaunchExecutorTui(executorNodeId)).rejects.toMatchObject({
      code: 'orch.executor_unavailable',
    })
    expect(harness.service.healthOf(executorNodeId)).toBe('unavailable')
    expect(harness.tuiRelaunches).toEqual([])
  })

  it('answers false without an active link', async () => {
    const { harness } = await spawnedHarness()
    await expect(harness.service.relaunchExecutorTui('nobody')).resolves.toBe(false)
    expect(harness.tuiRelaunches).toEqual([])
  })

  it('answers false for a link that is not in service mode', async () => {
    const { harness, executorNodeId, linkId } = await spawnedHarness()
    harness.links.rows.set(linkId, { ...harness.links.rows.get(linkId)!, runtimeMode: 'terminal' })
    await expect(harness.service.relaunchExecutorTui(executorNodeId)).resolves.toBe(false)
    expect(harness.tuiRelaunches).toEqual([])
  })
})
