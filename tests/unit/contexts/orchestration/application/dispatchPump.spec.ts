import { describe, expect, it } from 'vitest'
import type { OrchestrationContext } from '../../../../../src/contexts/orchestration/application/OrchestrationService'
import type { InMemoryDispatchLedger } from './inMemoryDispatchLedger'
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

type Spawned = Awaited<ReturnType<typeof spawnedHarness>>

const internals = (harness: Spawned['harness']) =>
  harness.service as unknown as {
    ctx: OrchestrationContext
    deps: { ledger: InMemoryDispatchLedger; onBackgroundError?: (error: unknown) => void }
  }

/** Runs `inject` right after the service accepted the turn, before the dispatch is settled. */
function afterAccept(spawned: Spawned, inject: () => void) {
  const original = spawned.runtime.startTurn
  spawned.runtime.startTurn = async input => {
    const turn = await original(input)
    inject()
    return turn
  }
}

function collectBackgroundErrors(harness: Spawned['harness']): unknown[] {
  const errors: unknown[] = []
  internals(harness).deps.onBackgroundError = error => errors.push(error)
  return errors
}

describe('dispatchPump', () => {
  it('T5: a settle that fails once after the accept still ends sent, with a single startTurn', async () => {
    const spawned = await spawnedHarness()
    const { harness, executorNodeId, runtime } = spawned
    afterAccept(spawned, () => {
      internals(harness).deps.ledger.failAt = 'settle'
    })
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)).toMatchObject({ state: 'sent', turnRef: 'turn-1' })
    expect(runtime.startedTurns).toHaveLength(1)
  })

  it('T6: a settle that commits and then fails leaves sent and raises no background error', async () => {
    const spawned = await spawnedHarness()
    const { harness, executorNodeId, runtime } = spawned
    const errors = collectBackgroundErrors(harness)
    const { ledger } = internals(harness).deps
    const settle = ledger.settleDispatch.bind(ledger)
    let failed = false
    ledger.settleDispatch = async input => {
      const result = await settle(input)
      if (!failed && input.next.state === 'sent') {
        failed = true
        throw new Error('lost after commit')
      }
      return result
    }
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)?.state).toBe('sent')
    expect(runtime.startedTurns).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('T7: a settle that always fails is healed by turn.started carrying the dispatch id', async () => {
    const spawned = await spawnedHarness()
    const { harness, executorNodeId, runtime } = spawned
    collectBackgroundErrors(harness)
    const { ledger } = internals(harness).deps
    const settle = ledger.settleDispatch.bind(ledger)
    let broken = false
    ledger.settleDispatch = async input => {
      if (broken && input.next.state !== 'reserved') {
        throw new Error('write failed')
      }
      return settle(input)
    }
    afterAccept(spawned, () => {
      broken = true
    })
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)?.state).toBe('reserved')
    broken = false
    runtime.emit(startedEvent('turn-1', D1))
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)).toMatchObject({ state: 'sent', turnRef: 'turn-1' })
    expect(harness.dispatches.rows.get(D1)?.glimpseTurnId).toMatch(/^glimpse-/)
  })

  it('T10: an isolated service.unavailable wakes the pump, which fails the queued dispatch', async () => {
    const { harness, executorNodeId } = await queuedBehindScreenTurn()
    const { ctx } = internals(harness)
    ctx.onRuntimeEvent(ctx.slotOf(executorNodeId), { type: 'service.unavailable' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)).toMatchObject({ state: 'failed', reason: 'not_sent' })
  })

  it('T12: an executor that goes down with a reserved dispatch queues only executor_down_in_turn', async () => {
    const { harness, executorNodeId } = await queuedBehindScreenTurn()
    const queued = harness.dispatches.rows.get(D1)!
    harness.dispatches.rows.set(D1, {
      ...queued,
      state: 'reserved',
      reservedAt: harness.clock.now().toISOString(),
      revision: queued.revision + 1,
    })
    await harness.service.markExecutorUnavailable(executorNodeId)
    expect(harness.dispatches.rows.get(D1)).toMatchObject({
      state: 'failed',
      reason: 'executor_down',
    })
    expect(harness.notices.rows.map(row => row.entry.kind)).toEqual(['executor_down_in_turn'])
  })

  it('T18: a reservation that finds another dispatch in flight answers null and sends nothing', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'first' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)?.state).toBe('sent')
    const queued = { ...harness.dispatches.rows.get(D1)!, id: D2, state: 'queued' as const }
    harness.dispatches.rows.set(D2, { ...queued, text: 'second', turnRef: null, revision: 1 })
    harness.dispatches.findInFlightByExecutor = async () => null
    await harness.service.finishBoot()
    await harness.service.whenIdle()
    expect(runtime.startedTurns).toHaveLength(1)
    expect(harness.dispatches.rows.get(D2)?.state).toBe('queued')
  })

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
