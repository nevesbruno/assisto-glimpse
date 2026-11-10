import { describe, expect, it } from 'vitest'
import {
  codedError,
  completedEvent,
  orchestratorPrincipal,
  spawnedHarness,
  startedEvent,
  USER,
} from './fakes'

const H1 = { key: 'k1', event: 'PreToolUse', origin: '/home/u/hook.sh', currentHash: 'hash-1' }
const H2 = { key: 'k2', event: 'Stop', origin: '/home/u/stop.sh', currentHash: 'hash-2' }

async function withPendingHooks() {
  const spawned = await spawnedHarness()
  spawned.runtime.emit({ type: 'hooks.trust_pending', hooks: [H1, H2] })
  await spawned.harness.service.whenIdle()
  return spawned
}

const pending = async (spawned: Awaited<ReturnType<typeof withPendingHooks>>) =>
  (await spawned.harness.service.status(USER, { to: spawned.executorNodeId })).links[0].pendingHooks

const QUEUED = '33333333-3333-4333-8333-333333333331'

async function queuedBehindScreenTurnWithApprovedHooks() {
  const spawned = await withPendingHooks()
  spawned.runtime.emit(startedEvent('screen-1', null, 'screen'))
  await spawned.harness.service.dispatch(orchestratorPrincipal(), {
    dispatchId: QUEUED,
    to: spawned.executorNodeId,
    text: 'queued work',
  })
  await spawned.harness.service.approveHooks(USER, {
    executorNodeId: spawned.executorNodeId,
    keys: ['k1'],
  })
  return spawned
}

describe('hook approvals', () => {
  it('T8: with a dispatch queued behind the screen turn, the service restarts before any send', async () => {
    const spawned = await queuedBehindScreenTurnWithApprovedHooks()
    spawned.runtime.emit(completedEvent('screen-1', null))
    await spawned.harness.service.whenIdle()
    expect(spawned.runtime.closes).toEqual(['restart'])
    expect(spawned.runtime.startedTurns).toHaveLength(0)
    const next = spawned.harness.runtimes.get(spawned.executorNodeId)!
    expect(next.startedTurns).toEqual([{ dispatchId: QUEUED, text: 'queued work' }])
    expect(spawned.harness.dispatches.rows.get(QUEUED)?.state).toBe('sent')
  })

  it('T9: a restart whose start fails fails the queued dispatch as not_sent with no manual call', async () => {
    const spawned = await queuedBehindScreenTurnWithApprovedHooks()
    spawned.harness.failNextStart.error = codedError('executor.start_failed')
    spawned.runtime.emit(completedEvent('screen-1', null))
    await spawned.harness.service.whenIdle()
    expect(spawned.harness.dispatches.rows.get(QUEUED)).toMatchObject({
      state: 'failed',
      reason: 'not_sent',
    })
    expect(spawned.runtime.startedTurns).toHaveLength(0)
  })

  it('records the pair read from the service with who, event and origin, and lowers the count', async () => {
    const spawned = await withPendingHooks()
    expect(await pending(spawned)).toBe(2)
    await spawned.harness.service.approveHooks(USER, {
      executorNodeId: spawned.executorNodeId,
      keys: ['k1'],
    })
    expect(spawned.harness.hookApprovals.rows).toEqual([
      expect.objectContaining({
        key: 'k1',
        currentHash: 'hash-1',
        eventName: 'PreToolUse',
        sourcePath: '/home/u/hook.sh',
        approvedBy: 'user',
      }),
    ])
    expect(await pending(spawned)).toBe(1)
  })

  it('restarts the service at once when the executor is idle, resuming the session and relaunching the TUI', async () => {
    const spawned = await withPendingHooks()
    const result = await spawned.harness.service.approveHooks(USER, {
      executorNodeId: spawned.executorNodeId,
      keys: ['k1'],
    })
    await spawned.harness.service.whenIdle()
    expect(result).toEqual({ approved: 1, restart: 'done' })
    expect(spawned.runtime.closes).toEqual(['restart'])
    expect(spawned.harness.starts).toHaveLength(2)
    const next = spawned.harness.runtimes.get(spawned.executorNodeId)!
    expect(next).not.toBe(spawned.runtime)
    expect(next.resumeRefs[0]).toBe(`session-of-${spawned.executorNodeId}`)
    expect(spawned.harness.tuiLaunches).toEqual([spawned.executorNodeId, spawned.executorNodeId])
  })

  it('records at once but defers the restart while a turn runs, doing it when the executor goes idle', async () => {
    const spawned = await withPendingHooks()
    spawned.runtime.emit(startedEvent('screen-1', null, 'screen'))
    await spawned.harness.service.whenIdle()
    const result = await spawned.harness.service.approveHooks(USER, {
      executorNodeId: spawned.executorNodeId,
      keys: ['k1', 'k2'],
    })
    expect(result).toEqual({ approved: 2, restart: 'scheduled' })
    expect(spawned.harness.hookApprovals.rows).toHaveLength(2)
    expect(spawned.runtime.closes).toHaveLength(0)
    spawned.runtime.emit(completedEvent('screen-1', null))
    await spawned.harness.service.whenIdle()
    expect(spawned.runtime.closes).toEqual(['restart'])
    expect(spawned.harness.starts).toHaveLength(2)
  })

  it('a different hash is another approval and does not lower the count', async () => {
    const spawned = await withPendingHooks()
    await spawned.harness.service.approveHooks(USER, {
      executorNodeId: spawned.executorNodeId,
      keys: ['k1'],
    })
    await spawned.harness.service.whenIdle()
    const next = spawned.harness.runtimes.get(spawned.executorNodeId)!
    next.emit({ type: 'hooks.trust_pending', hooks: [{ ...H1, currentHash: 'hash-changed' }, H2] })
    await spawned.harness.service.whenIdle()
    expect(await pending(spawned)).toBe(2)
  })

  it('refuses a key outside the pending list and records nothing, even beside a valid key', async () => {
    const spawned = await withPendingHooks()
    await expect(
      spawned.harness.service.approveHooks(USER, {
        executorNodeId: spawned.executorNodeId,
        keys: ['k1', 'forged'],
      }),
    ).rejects.toMatchObject({ code: 'common.invalid_input' })
    expect(spawned.harness.hookApprovals.rows).toHaveLength(0)
    expect(spawned.runtime.closes).toHaveLength(0)
  })

  it('refuses an unlinked executor and an orchestrator agent', async () => {
    const spawned = await withPendingHooks()
    await expect(
      spawned.harness.service.approveHooks(USER, { executorNodeId: 'ghost', keys: ['k1'] }),
    ).rejects.toMatchObject({ code: 'orch.not_linked' })
    await expect(
      spawned.harness.service.approveHooks(orchestratorPrincipal(), {
        executorNodeId: spawned.executorNodeId,
        keys: ['k1'],
      }),
    ).rejects.toMatchObject({ code: 'orch.forbidden' })
  })
})
