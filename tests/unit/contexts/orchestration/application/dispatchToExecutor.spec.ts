/* oxlint-disable no-await-in-loop */
import { describe, expect, it } from 'vitest'
import { OrchestrationError } from '../../../../../src/contexts/orchestration/domain/agentLink'
import {
  orchestrationDispatchResultSchema,
  orchestrationStatusResultSchema,
} from '../../../../../src/shared/contracts/dto/orchestration'
import {
  codedError,
  completedEvent,
  orchestratorPrincipal,
  sha256,
  spawnedHarness,
  startedEvent,
  USER,
} from './fakes'

const orq = orchestratorPrincipal()
const D1 = '22222222-2222-4222-8222-222222222221'
const D2 = '22222222-2222-4222-8222-222222222222'
const D3 = '22222222-2222-4222-8222-222222222223'
const D4 = '22222222-2222-4222-8222-222222222224'
const D5 = '22222222-2222-4222-8222-222222222225'

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('dispatchToExecutor (U-02)', () => {
  it('T1: a limit extended by another writer after the read survives the accept', async () => {
    const { harness, executorNodeId, linkId } = await spawnedHarness()
    const stored = harness.dispatches.findById
    let extended = false
    harness.dispatches.findById = async id => {
      if (!extended) {
        extended = true
        await harness.links.extendRounds(linkId, 2, '2026-11-09T12:00:01.000Z')
      }
      return stored(id)
    }
    const result = await harness.service.dispatch(orq, {
      dispatchId: D1,
      to: executorNodeId,
      text: 'do it',
    })
    expect(result).toMatchObject({ round: 1, roundsLimit: 5 })
    expect(harness.links.rows.get(linkId)).toMatchObject({ roundsUsed: 1, roundsLimit: 5 })
  })

  it('an extension asked during a dispatch waits for it and both are kept', async () => {
    const { harness, executorNodeId, linkId } = await spawnedHarness()
    const [dispatched] = await Promise.all([
      harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'do it' }),
      harness.service.extendRounds(USER, { linkId, rounds: 2 }),
    ])
    expect(dispatched.round).toBe(1)
    expect(harness.links.rows.get(linkId)).toMatchObject({ roundsUsed: 1, roundsLimit: 5 })
  })

  it('accepts as queued, consumes a round and the pump reserves at once on a ready executor', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    const result = await harness.service.dispatch(orq, {
      dispatchId: D1,
      to: executorNodeId,
      text: 'do it',
    })
    expect(orchestrationDispatchResultSchema.parse(result)).toBeTruthy()
    expect(result).toMatchObject({
      dispatchId: D1,
      state: 'queued',
      round: 1,
      roundsLimit: 3,
      duplicate: false,
    })
    expect(result.admission).toEqual({
      canDispatch: false,
      reason: 'dispatch_in_flight',
      blocking: { dispatchId: D1, state: 'queued', round: 1 },
      willWait: false,
    })
    await harness.service.whenIdle()
    expect(runtime.startedTurns).toEqual([{ dispatchId: D1, text: 'do it' }])
    expect(harness.dispatches.rows.get(D1)).toMatchObject({
      state: 'sent',
      text: null,
      turnRef: 'turn-1',
    })
  })

  it('stores the sha256 of the text computed by the application', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'héllo ✓' })
    const stored = harness.dispatches.rows.get(D1)!
    expect(stored.textSha256).toBe(sha256('héllo ✓'))
    expect(stored.textBytes).toBe(Buffer.byteLength('héllo ✓'))
  })

  it('D5 with the same payload returns the record with duplicate and no new round', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'same' })
    await harness.service.whenIdle()
    const again = await harness.service.dispatch(orq, {
      dispatchId: D1,
      to: executorNodeId,
      text: 'same',
    })
    expect(again).toMatchObject({ dispatchId: D1, state: 'sent', duplicate: true, round: 1 })
    expect(harness.dispatches.insertCalls).toBe(1)
    expect([...harness.links.rows.values()][0].roundsUsed).toBe(1)
  })

  it('D5 with another text is orch.dispatch_conflict', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'one' })
    await expectCode(
      harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'two' }),
      'orch.dispatch_conflict',
    )
  })

  it('refuses a second dispatch with the first outside a final state, writing nothing and keeping the round', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'one' })
    await harness.service.whenIdle()
    const link = [...harness.links.rows.values()][0]
    const writes = harness.dispatches.insertCalls
    const error = await harness.service
      .dispatch(orq, { dispatchId: D2, to: executorNodeId, text: 'other text' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error).toMatchObject({
      code: 'orch.dispatch_in_flight',
      blocking: { dispatchId: D1, state: 'sent', round: 1 },
    })
    expect(harness.dispatches.insertCalls).toBe(writes)
    expect([...harness.links.rows.values()][0]).toEqual(link)
  })

  it('refusal by queued is also in flight (queued counts as open, D1) and the same text is not special (D6)', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    runtime.emit(startedEvent('screen-1', null, 'screen'))
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D1)?.state).toBe('queued')
    await expectCode(
      harness.service.dispatch(orq, { dispatchId: D2, to: executorNodeId, text: 'x' }),
      'orch.dispatch_in_flight',
    )
  })

  it('a turn from the screen holds the queued dispatch, and the end of that turn wakes the pump', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    runtime.emit(startedEvent('screen-1', null, 'screen'))
    const result = await harness.service.dispatch(orq, {
      dispatchId: D1,
      to: executorNodeId,
      text: 'wait',
    })
    expect(result.state).toBe('queued')
    await harness.service.whenIdle()
    expect(runtime.startedTurns).toHaveLength(0)
    expect(harness.dispatches.rows.get(D1)?.state).toBe('queued')
    const status = await harness.service.status(orq, {})
    expect(status.links[0]).toMatchObject({ health: 'busy' })
    runtime.emit(completedEvent('screen-1', null))
    await harness.service.whenIdle()
    expect(runtime.startedTurns).toHaveLength(1)
    expect(harness.dispatches.rows.get(D1)?.state).toBe('sent')
  })

  it('accepts with willWait while the executor is not ready, then runs on executor.ready', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    runtime.emit({ type: 'executor.degraded', reason: 'slow' })
    const status = await harness.service.status(orq, {})
    expect(status.links[0].admission).toMatchObject({ canDispatch: true, willWait: true })
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'later' })
    await harness.service.whenIdle()
    expect(runtime.startedTurns).toHaveLength(0)
    runtime.emit({ type: 'executor.ready', sessionRef: 's', resumed: false, version: '1' })
    await harness.service.whenIdle()
    expect(runtime.startedTurns).toHaveLength(1)
  })

  it('same text after the conclusion is a new dispatch that consumes a round', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'repeat' })
    await harness.service.whenIdle()
    runtime.emit(completedEvent('turn-1', D1))
    await harness.service.whenIdle()
    const second = await harness.service.dispatch(orq, {
      dispatchId: D2,
      to: executorNodeId,
      text: 'repeat',
    })
    expect(second).toMatchObject({ round: 2, duplicate: false })
  })

  it('D7: the fourth dispatch is orch.round_limit_reached and does not consume a round', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    const ids = [D1, D2, D3]
    for (const [index, id] of ids.entries()) {
      await harness.service.dispatch(orq, { dispatchId: id, to: executorNodeId, text: `t${index}` })
      await harness.service.whenIdle()
      runtime.emit(completedEvent(`turn-${index + 1}`, id))
      await harness.service.whenIdle()
    }
    const before = [...harness.links.rows.values()][0]
    await expectCode(
      harness.service.dispatch(orq, { dispatchId: D4, to: executorNodeId, text: 't4' }),
      'orch.round_limit_reached',
    )
    expect([...harness.links.rows.values()][0]).toEqual(before)
    expect(harness.dispatches.rows.has(D4)).toBe(false)
  })

  it('T16: interrupt translates an executor.unavailable error of the runtime', async () => {
    const { harness, executorNodeId, runtime } = await spawnedHarness()
    runtime.interrupt = async () => {
      throw codedError('executor.unavailable')
    }
    await expectCode(
      harness.service.interrupt(orq, { to: executorNodeId }),
      'orch.executor_unavailable',
    )
  })

  it('refuses with orch.executor_unavailable and writes nothing', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    harness.runtimes.get(executorNodeId)!.emit({
      type: 'executor.down',
      reason: 'exit',
      exitCode: 1,
      signal: null,
    })
    await harness.service.markExecutorUnavailable(executorNodeId)
    await expectCode(
      harness.service.dispatch(orq, { dispatchId: D5, to: executorNodeId, text: 'x' }),
      'orch.executor_unavailable',
    )
    expect(harness.dispatches.insertCalls).toBe(0)
  })

  it('status admission is the one the dispatch returns (same function)', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    const before = await harness.service.status(orq, { to: executorNodeId })
    expect(before.links[0].admission).toMatchObject({ canDispatch: true, willWait: false })
    const result = await harness.service.dispatch(orq, {
      dispatchId: D1,
      to: executorNodeId,
      text: 'a',
    })
    await harness.service.whenIdle()
    const after = await harness.service.status(orq, { to: executorNodeId })
    expect(orchestrationStatusResultSchema.parse(after)).toBeTruthy()
    expect(result.admission.blocking).toMatchObject({ dispatchId: D1, state: 'queued' })
    const again = await harness.service.dispatch(orq, {
      dispatchId: D1,
      to: executorNodeId,
      text: 'a',
    })
    expect(after.links[0].admission).toEqual(again.admission)
    expect(after.links[0].admission.blocking).toMatchObject({ dispatchId: D1, state: 'sent' })
    expect(after.links[0].current).toMatchObject({ dispatchId: D1, round: 1 })
  })

  it('rejects an invalid text through the domain rule without storing anything', async () => {
    const { harness, executorNodeId } = await spawnedHarness()
    await expect(
      harness.service.dispatch(USER, { dispatchId: D1, to: executorNodeId, text: '' }),
    ).rejects.toMatchObject({ code: 'invalid_text' })
    expect(harness.dispatches.insertCalls).toBe(0)
  })
})
