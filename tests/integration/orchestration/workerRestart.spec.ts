// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeRuntime } from '../../unit/contexts/orchestration/application/fakes'
import {
  AS_ORCHESTRATOR,
  dispatchId,
  EXECUTOR_NODE,
  bootAndLink,
  createRig,
  settle,
  waitForRealIO,
  type Rig,
  type RigWorker,
} from './phase2Rig'

const NEVER = new Promise<never>(() => undefined)
const ID = dispatchId(1)

let rig: Rig
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'))
  rig = createRig()
})
afterEach(() => {
  vi.useRealTimers()
  rig.dispose()
})

/** First Worker with a linked executor and one dispatch held by `hold` at the service write. */
async function workerDyingAt(hold: (runtime: FakeRuntime) => void): Promise<RigWorker> {
  const first = rig.startWorker({ onRuntime: hold })
  await bootAndLink(first)
  await first.composed.service.dispatch(AS_ORCHESTRATOR, {
    dispatchId: ID,
    to: EXECUTOR_NODE,
    text: 'go',
  })
  await settle()
  first.kill()
  return first
}

const turnsSentTo = (...workers: RigWorker[]): number =>
  workers.flatMap(worker => worker.runtimes).reduce((sum, rt) => sum + rt.startedTurns.length, 0)

describe('I-02 Worker restart in the middle of a dispatch (fake runtime)', () => {
  it('after the reserved commit and before the service write: uncertain, then failed(not_sent) with the round refunded and one notice', async () => {
    const first = await workerDyingAt(runtime => {
      runtime.startTurn = () => NEVER
    })
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'reserved' })
    expect(rig.linkRow()?.roundsUsed).toBe(1)

    const seenByService: (string | undefined)[] = []
    const second = rig.startWorker({
      onRuntime: runtime => {
        runtime.findResults.set(ID, { kind: 'absent' })
        const find = runtime.findTurnByDispatch
        runtime.findTurnByDispatch = async id => {
          seenByService.push(rig.dispatchRow(id)?.state)
          return find(id)
        }
      },
    })
    await second.composed.boot()
    await settle()

    expect(seenByService).toEqual(['uncertain'])
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'failed', reason: 'not_sent' })
    expect(rig.linkRow()?.roundsUsed).toBe(0)
    expect(rig.notices().map(notice => notice.kind)).toEqual(['failed_not_sent'])
    expect(turnsSentTo(first, second)).toBe(0)
  })

  /**
   * App defect found on 11/11/2026, src untouched (card F2-16a1): `adoptRunningTurn` calls the real
   * run state ingress before the boot relaunches the TUI, and `recordTurnStarted` throws "No live
   * session for executor node" without a bound session. The boot logs and swallows it, so the
   * dispatch stays `uncertain` with no notice instead of following as `sent` (documented in
   * ORCHESTRATION_RISKS_AND_TESTS.md, I-02). The test fails while the defect exists.
   */
  it.fails(
    'after the write and before the answer: the turn is found by dispatchId and follows as sent, with one turn/start in the service',
    async () => {
      const first = await workerDyingAt(runtime => {
        const startTurn = runtime.startTurn
        runtime.startTurn = input => {
          void startTurn(input)
          return NEVER
        }
      })
      expect(first.runtimes[0].startedTurns).toHaveLength(1)

      const second = rig.startWorker({
        onRuntime: runtime =>
          runtime.findResults.set(ID, {
            kind: 'found',
            turn: { turnRef: 'turn-1', status: 'running', finalMessage: null, usage: null },
          }),
      })
      await second.composed.boot()
      await settle()

      expect(second.log).toHaveBeenCalledWith('orchestration boot step failed', {
        error: expect.stringContaining('No live session for executor node'),
      })
      expect(rig.dispatchRow(ID)).toMatchObject({ state: 'sent' })
      expect(rig.linkRow()?.roundsUsed).toBe(1)
      expect(second.runtimes[0].startedTurns).toHaveLength(0)
      expect(turnsSentTo(first, second)).toBe(1)
    },
  )

  it('after the write and before the answer: a turn already finished closes as completed with one notice', async () => {
    await workerDyingAt(runtime => {
      runtime.startTurn = () => NEVER
    })
    const second = rig.startWorker({
      onRuntime: runtime =>
        runtime.findResults.set(ID, {
          kind: 'found',
          turn: { turnRef: 'turn-1', status: 'completed', finalMessage: 'done', usage: null },
        }),
    })
    await second.composed.boot()
    await settle()

    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'completed' })
    expect(rig.notices().map(notice => notice.kind)).toEqual(['completed'])
    expect(second.runtimes[0].startedTurns).toHaveLength(0)
  })

  it('with the turn running (sent): the new service resumes the thread and the turn closes as completed, with one notice', async () => {
    const first = rig.startWorker()
    await bootAndLink(first)
    await first.composed.service.dispatch(AS_ORCHESTRATOR, {
      dispatchId: ID,
      to: EXECUTOR_NODE,
      text: 'go',
    })
    await settle()
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'sent' })
    const sessionRef = first.runtimes[0].spec.sessionRef
    first.kill()

    const second = rig.startWorker({
      onRuntime: runtime =>
        runtime.findResults.set(ID, {
          kind: 'found',
          turn: { turnRef: 'turn-1', status: 'running', finalMessage: null, usage: null },
        }),
    })
    await second.composed.boot()
    await settle()
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'sent' })
    expect(second.runtimes).toHaveLength(1)
    expect(second.runtimes[0].resumeRefs[0]).not.toBeNull()
    expect(sessionRef).toBeNull()

    second.runtimes[0].emit({
      type: 'turn.completed',
      turnRef: 'turn-1',
      dispatchId: ID,
      outcome: 'completed',
      finalMessage: 'ok',
    } as never)
    await settle()

    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'completed' })
    expect(rig.notices().map(notice => notice.kind)).toEqual(['completed'])
  })

  it('with the turn running (sent) and gone from the new service: failed(executor_down) with one notice', async () => {
    const first = rig.startWorker()
    await bootAndLink(first)
    await first.composed.service.dispatch(AS_ORCHESTRATOR, {
      dispatchId: ID,
      to: EXECUTOR_NODE,
      text: 'go',
    })
    await settle()
    first.kill()

    const second = rig.startWorker({
      onRuntime: runtime => runtime.findResults.set(ID, { kind: 'absent' }),
    })
    await second.composed.boot()
    await settle()

    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'failed', reason: 'executor_down' })
    expect(rig.notices().map(notice => notice.kind)).toEqual(['executor_down_in_turn'])
    expect(turnsSentTo(second)).toBe(0)
  })

  it('during the reconciliation itself: the second boot reaches the same result, with no repeated notice and no send', async () => {
    const first = await workerDyingAt(runtime => {
      runtime.startTurn = () => NEVER
    })
    const midway = rig.startWorker({
      onRuntime: runtime => {
        runtime.findTurnByDispatch = () => NEVER
      },
    })
    void midway.composed.boot()
    await settle()
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'uncertain' })
    midway.kill()

    const third = rig.startWorker({
      onRuntime: runtime => runtime.findResults.set(ID, { kind: 'absent' }),
    })
    await third.composed.boot()
    await settle()
    const fourth = rig.startWorker({
      onRuntime: runtime => runtime.findResults.set(ID, { kind: 'absent' }),
    })
    await fourth.composed.boot()
    await settle()

    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'failed', reason: 'not_sent' })
    expect(rig.linkRow()?.roundsUsed).toBe(0)
    expect(rig.notices().map(notice => notice.kind)).toEqual(['failed_not_sent'])
    expect(turnsSentTo(first, midway, third, fourth)).toBe(0)
  })

  it('a new orch.dispatch waits for the reconciliation and then gets orch.dispatch_in_flight without taking a round', async () => {
    await workerDyingAt(runtime => {
      runtime.startTurn = () => NEVER
    })
    let release: (() => void) | undefined
    let reconciling = false
    const second = rig.startWorker({
      onRuntime: runtime => {
        runtime.findTurnByDispatch = () =>
          new Promise(resolve => {
            reconciling = true
            release = () => resolve({ kind: 'unknown' })
          })
      },
    })
    void second.composed.boot()
    // The boot reaps the orphan with a real `ps`; wait for the reconciliation to hold the slot.
    await waitForRealIO(() => reconciling)
    expect(reconciling).toBe(true)

    const refusal = second.composed.service
      .dispatch(AS_ORCHESTRATOR, { dispatchId: dispatchId(2), to: EXECUTOR_NODE, text: 'again' })
      .then(
        () => 'accepted',
        (error: { code?: string }) => error.code,
      )
    const early = await Promise.race([refusal, settle(50).then(() => 'pending')])
    expect(early).toBe('pending')

    release?.()
    await settle()

    await expect(refusal).resolves.toBe('orch.dispatch_in_flight')
    expect(rig.dispatchRow(dispatchId(2))).toBeUndefined()
    expect(rig.linkRow()?.roundsUsed).toBe(1)
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'uncertain' })
    expect(rig.notices().map(notice => notice.kind)).toEqual(['uncertain'])
  })
})

// The real SIGKILL restart of a Worker process needs a child Worker harness, which E-02 in F2-16b
// owns. This spec keeps the fake-runtime I-02 matrix; the real variant stays declared and skipped.
const realCodex = process.env.OPENCOVE_TEST_REAL_CODEX === '1'

describe.skipIf(!realCodex)('I-02 real Worker restart (owned by E-02 in F2-16b)', () => {
  it.todo('SIGKILL a child Worker with a real app-server and let the next boot reap the orphan')
})
