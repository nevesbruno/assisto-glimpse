import { describe, expect, it } from 'vitest'
import {
  createDispatch,
  type DispatchState,
} from '../../../../../src/contexts/orchestration/domain/dispatch'
import type { FindTurnResult } from '../../../../../src/contexts/orchestration/application/ports'
import {
  codedError,
  completedEvent,
  orchestratorPrincipal,
  readyEvent,
  sha256,
  spawnedHarness,
  uuidFrom,
  type Harness,
} from './fakes'

const D = uuidFrom('boot-1')

function found(status: 'running' | 'completed' | 'failed' | 'interrupted'): FindTurnResult {
  return {
    kind: 'found',
    turn: {
      turnRef: 'turn-9',
      status,
      finalMessage: status === 'running' ? null : 'out',
      usage: null,
    },
  }
}

function seed(harness: Harness, linkId: string, state: DispatchState, id = D) {
  const link = harness.links.rows.get(linkId)!
  const { dispatch } = createDispatch({
    id,
    link,
    text: 'work',
    textSha256: sha256('work'),
    now: harness.clock.now(),
  })
  const at = harness.clock.now().toISOString()
  harness.links.rows.set(linkId, { ...link, roundsUsed: dispatch.round })
  harness.dispatches.rows.set(id, {
    ...dispatch,
    state,
    text: state === 'reserved' ? 'work' : null,
    reservedAt: at,
    sentAt: state === 'sent' ? at : null,
    turnRef: state === 'sent' ? 'turn-9' : null,
    revision: 3,
  })
}

async function reboot(state: DispatchState, response: FindTurnResult | 'unavailable') {
  const { harness, linkId, executorNodeId } = await spawnedHarness()
  seed(harness, linkId, state)
  if (response === 'unavailable') {
    harness.failNextStart.error = codedError('executor.start_failed')
  } else {
    harness.hooks.onRuntimeStart = runtime => runtime.findResults.set(D, response)
  }
  const service = harness.restart()
  await service.reconcileOnBoot()
  await service.whenIdle()
  const noticeKinds = harness.notices.rows.map(row => row.entry.kind)
  return {
    harness,
    service,
    linkId,
    executorNodeId,
    noticeKinds,
    dispatch: harness.dispatches.rows.get(D)!,
  }
}

const roundsUsed = (harness: Harness) => [...harness.links.rows.values()][0].roundsUsed

describe('reconcileOnBoot matrix', () => {
  const absent: FindTurnResult = { kind: 'absent' }
  const unknown: FindTurnResult = { kind: 'unknown' }
  const cases: [
    string,
    DispatchState,
    FindTurnResult,
    string,
    string | null,
    number,
    string | null,
  ][] = [
    ['uncertain found running', 'uncertain', found('running'), 'sent', null, 1, null],
    [
      'uncertain found completed',
      'uncertain',
      found('completed'),
      'completed',
      null,
      1,
      'completed',
    ],
    [
      'uncertain found failed',
      'uncertain',
      found('failed'),
      'failed',
      'turn_failed',
      1,
      'failed_turn_failed',
    ],
    [
      'uncertain found interrupted',
      'uncertain',
      found('interrupted'),
      'failed',
      'executor_down',
      1,
      'executor_down_in_turn',
    ],
    ['uncertain absent', 'uncertain', absent, 'failed', 'not_sent', 0, 'failed_not_sent'],
    ['uncertain unknown', 'uncertain', unknown, 'uncertain', null, 1, 'uncertain'],
    ['sent found running', 'sent', found('running'), 'sent', null, 1, null],
    ['sent found completed', 'sent', found('completed'), 'completed', null, 1, 'completed'],
    [
      'sent found failed',
      'sent',
      found('failed'),
      'failed',
      'turn_failed',
      1,
      'failed_turn_failed',
    ],
    [
      'sent found interrupted',
      'sent',
      found('interrupted'),
      'failed',
      'executor_down',
      1,
      'executor_down_in_turn',
    ],
    ['sent absent', 'sent', absent, 'failed', 'executor_down', 1, 'executor_down_in_turn'],
    ['sent unknown', 'sent', unknown, 'sent', null, 1, null],
    ['reserved found running', 'reserved', found('running'), 'sent', null, 1, null],
    ['reserved found completed', 'reserved', found('completed'), 'completed', null, 1, 'completed'],
    ['reserved absent', 'reserved', absent, 'failed', 'not_sent', 0, 'failed_not_sent'],
    ['reserved unknown', 'reserved', unknown, 'uncertain', null, 1, 'uncertain'],
  ]

  it.each(cases)('%s', async (_name, state, response, finalState, reason, rounds, lastNotice) => {
    const { harness, dispatch, noticeKinds } = await reboot(state, response)
    expect(dispatch.state).toBe(finalState)
    expect(dispatch.reason).toBe(reason)
    expect(roundsUsed(harness)).toBe(rounds)
    expect(noticeKinds.at(-1) ?? null).toBe(lastNotice)
    expect(dispatch.state === 'reserved').toBe(false)
  })

  it('T11: a reserved dispatch resolved as completed queues only the completed notice', async () => {
    const { noticeKinds } = await reboot('reserved', found('completed'))
    expect(noticeKinds).toEqual(['completed'])
  })

  it.each(['reserved', 'uncertain', 'sent'] as const)(
    'unavailable health fails %s as executor_down and tells the run state',
    async state => {
      const { harness, dispatch, noticeKinds, executorNodeId } = await reboot(state, 'unavailable')
      expect(dispatch).toMatchObject({ state: 'failed', reason: 'executor_down' })
      expect(noticeKinds.at(-1)).toBe('executor_down_in_turn')
      expect(roundsUsed(harness)).toBe(1)
      expect(harness.runState.recordExecutorDown).toEqual([[executorNodeId]])
    },
  )

  it('found running and unknown keep the dispatch in flight without a duplicate notice', async () => {
    const { harness, service, noticeKinds } = await reboot('uncertain', { kind: 'unknown' })
    expect(noticeKinds).toEqual(['uncertain'])
    await service.reconcileOnBoot()
    await service.whenIdle()
    expect(harness.notices.rows).toHaveLength(1)
  })

  it('ends in finishBoot: queued work is sent only after the reconciliation', async () => {
    const { harness, linkId, executorNodeId } = await spawnedHarness()
    seed(harness, linkId, 'queued')
    harness.dispatches.rows.set(D, {
      ...harness.dispatches.rows.get(D)!,
      text: 'work',
      reservedAt: null,
    })
    const service = harness.restart()
    await service.reconcileOnBoot()
    await service.whenIdle()
    expect(harness.runtimes.get(executorNodeId)!.startedTurns).toEqual([
      { dispatchId: D, text: 'work' },
    ])
    expect(harness.dispatches.rows.get(D)?.state).toBe('sent')
  })

  it('reserved becomes uncertain before any answer and orphans are reaped before the start', async () => {
    const calls: string[] = []
    const { harness, linkId } = await spawnedHarness()
    seed(harness, linkId, 'reserved')
    const service = harness.restart()
    const dispatchesAtReap: string[] = []
    ;(service as unknown as { deps: { reapOrphanServices: unknown } }).deps.reapOrphanServices =
      async () => {
        calls.push('reap')
        dispatchesAtReap.push(harness.dispatches.rows.get(D)!.state)
      }
    harness.hooks.onRuntimeStart = () => calls.push('start')
    await service.reconcileOnBoot()
    await service.whenIdle()
    expect(dispatchesAtReap).toEqual(['uncertain'])
    expect(calls).toEqual(['reap', 'start'])
  })
})

describe('executor incident after boot', () => {
  it('executor.down turns a reserved dispatch into uncertain and executor.recovered reconciles it', async () => {
    const { harness, runtime, executorNodeId, linkId } = await spawnedHarness()
    seed(harness, linkId, 'reserved')
    runtime.emit({ type: 'executor.down', reason: 'crash', exitCode: 1, signal: null })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D)?.state).toBe('uncertain')
    const status = await harness.service.status(orchestratorPrincipal(), { to: executorNodeId })
    expect(status.links[0].health).toBe('starting')

    runtime.findResults.set(D, found('completed'))
    runtime.emit({ type: 'executor.recovered', sessionRef: 's' })
    runtime.emit(readyEvent)
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D)).toMatchObject({ state: 'completed' })
    const after = await harness.service.status(orchestratorPrincipal(), { to: executorNodeId })
    expect(after.links[0].health).toBe('ready')
  })

  it('executor.recovered leaves a sent dispatch that is still running untouched', async () => {
    const { harness, runtime, linkId } = await spawnedHarness()
    seed(harness, linkId, 'sent')
    runtime.findResults.set(D, found('running'))
    runtime.emit({ type: 'executor.recovered', sessionRef: 's' })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D)?.state).toBe('sent')
    runtime.emit(completedEvent('turn-9', D))
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(D)?.state).toBe('completed')
  })
})
