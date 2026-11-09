import { describe, expect, it } from 'vitest'
import {
  createHarness,
  codedError,
  completedEvent,
  orchestratorPrincipal,
  spawnedHarness,
  startedEvent,
  uuidFrom,
} from './fakes'

const orq = orchestratorPrincipal()
const D1 = uuidFrom('pump-1')
const D2 = uuidFrom('pump-2')

const roundsUsed = (harness: Awaited<ReturnType<typeof spawnedHarness>>['harness']) =>
  [...harness.links.rows.values()][0].roundsUsed

async function queuedBehindScreenTurn() {
  const spawned = await spawnedHarness()
  spawned.runtime.emit(startedEvent('screen-1', null, 'screen'))
  await spawned.harness.service.dispatch(orq, {
    dispatchId: D1,
    to: spawned.executorNodeId,
    text: 'queued work',
  })
  await spawned.harness.service.whenIdle()
  return spawned
}

describe('dispatchPump', () => {
  it('never reserves before the boot work is done, and does once it finishes', async () => {
    const harness = createHarness()
    const result = await harness.service.spawn(orq, {
      requestId: uuidFrom('r'),
      provider: 'codex',
      prompt: 'first',
    })
    await harness.service.whenIdle()
    const runtime = harness.runtimes.get(result.executorNodeId)!
    expect(runtime.startedTurns).toHaveLength(0)
    expect(result.dispatch?.state).toBe('queued')
    await harness.service.finishBoot()
    await harness.service.whenIdle()
    expect(runtime.startedTurns).toHaveLength(1)
    expect(harness.dispatches.rows.get(result.dispatch!.dispatchId)?.state).toBe('sent')
  })

  it('the service refusing before the write fails not_sent, returns the round and queues a notice', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    runtime.startTurnError = codedError('executor.rejected')
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)).toMatchObject({
      state: 'failed',
      reason: 'not_sent',
      text: null,
    })
    expect(roundsUsed(harness)).toBe(0)
    expect(harness.notices.rows[0]).toMatchObject({
      dedupeKey: `${D1}:failed`,
      entry: { kind: 'failed_not_sent', dispatchId: D1 },
    })
    const status = await harness.service.status(orq, {})
    expect(status.links[0].admission.canDispatch).toBe(true)
  })

  it('a failure after the write becomes uncertain and is never sent again', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    runtime.startTurnError = codedError('executor.send_uncertain')
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
    await harness.service.whenIdle()
    runtime.startTurnError = null
    runtime.emit({ type: 'executor.ready', sessionRef: 's', resumed: false, version: '1' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)).toMatchObject({ state: 'uncertain', text: null })
    expect(runtime.startedTurns).toHaveLength(0)
    expect(roundsUsed(harness)).toBe(1)
  })

  it('cancel on queued returns the round and ends as cancelled', async () => {
    const { harness, executorNodeId } = await queuedBehindScreenTurn()
    expect(roundsUsed(harness)).toBe(1)
    const view = await harness.service.cancel(orq, { dispatchId: D1 })
    expect(view).toMatchObject({ dispatchId: D1, state: 'cancelled', reason: null })
    expect(roundsUsed(harness)).toBe(0)
    const again = await harness.service.dispatch(orq, {
      dispatchId: D2,
      to: executorNodeId,
      text: 'y',
    })
    expect(again.round).toBe(1)
  })

  it('cancel on a sent dispatch is refused as in flight', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
    await harness.service.whenIdle()
    await expect(harness.service.cancel(orq, { dispatchId: D1 })).rejects.toMatchObject({
      code: 'orch.dispatch_in_flight',
      blocking: { dispatchId: D1, state: 'sent' },
    })
  })

  it('queued with the executor turning unavailable fails not_sent with a notice and frees the admission', async () => {
    const { harness, executorNodeId } = await queuedBehindScreenTurn()
    await harness.service.markExecutorUnavailable(executorNodeId)
    expect(harness.dispatches.rows.get(D1)).toMatchObject({ state: 'failed', reason: 'not_sent' })
    expect(roundsUsed(harness)).toBe(0)
    expect(harness.notices.rows).toHaveLength(1)
    expect(harness.notices.rows[0].entry).toMatchObject({ kind: 'failed_not_sent', dispatchId: D1 })
    const status = await harness.service.status(orq, {})
    expect(status.links[0].admission).toMatchObject({
      canDispatch: false,
      reason: 'executor_unavailable',
      blocking: null,
    })
    expect(status.links[0].current).toBeNull()
  })

  it('executor_down on a sent dispatch ends the turn in the run state through the port', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
    await harness.service.whenIdle()
    await harness.service.markExecutorUnavailable(executorNodeId)
    expect(harness.dispatches.rows.get(D1)).toMatchObject({
      state: 'failed',
      reason: 'executor_down',
    })
    expect(roundsUsed(harness)).toBe(1)
    expect(harness.runState.recordExecutorDown).toEqual([[executorNodeId]])
    expect(harness.notices.rows[0].entry.kind).toBe('executor_down_in_turn')
  })

  it.each([
    ['completed', 'completed', null, 'completed'],
    ['failed', 'failed', 'turn_failed', 'failed_turn_failed'],
    ['interrupted', 'failed', 'interrupted', 'interrupted'],
  ] as const)(
    'turn.completed %s settles the dispatch and the run state',
    async (outcome, state, reason, kind) => {
      const { harness, executorNodeId, runtime } = await spawnedHarness()
      await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
      await harness.service.whenIdle()
      runtime.emit(startedEvent('turn-1', D1))
      runtime.emit(completedEvent('turn-1', D1, outcome, 'the final <b>text</b>'))
      await harness.service.whenIdle()
      const stored = harness.dispatches.rows.get(D1)!
      expect(stored).toMatchObject({ state, reason, outcome })
      expect(stored.glimpseTurnId).toMatch(/^glimpse-/)
      expect(harness.notices.rows[0].entry).toMatchObject({
        kind,
        glimpseTurnId: stored.glimpseTurnId,
      })
      expect(harness.runState.recordTurnCompleted).toHaveLength(1)
      expect(roundsUsed(harness)).toBe(1)
    },
  )

  it('never holds two open dispatches on one executor, whatever the interleaving', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    const attempts = [D1, D2].map(id =>
      harness.service
        .dispatch(orq, { dispatchId: id, to: executorNodeId, text: id })
        .catch(() => null),
    )
    await Promise.all(attempts)
    await harness.service.whenIdle()
    const open = [...harness.dispatches.rows.values()].filter(
      d => !['completed', 'failed', 'cancelled'].includes(d.state),
    )
    expect(open).toHaveLength(1)
    expect(roundsUsed(harness)).toBe(1)
  })
})
