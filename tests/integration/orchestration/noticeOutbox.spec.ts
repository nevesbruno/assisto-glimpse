// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AS_ORCHESTRATOR,
  bootAndLink,
  createRig,
  dispatchId,
  EXECUTOR_NODE,
  settle,
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

/** First Worker dies with the dispatch reserved and before any notice exists. */
async function workerDyingReserved(): Promise<RigWorker> {
  const first = rig.startWorker({ onRuntime: runtime => (runtime.startTurn = () => NEVER) })
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

/** New Worker over the same SQLite file, with the service answer the reconciliation will find. */
async function rebootFinding(kind: 'absent' | 'unknown'): Promise<RigWorker> {
  const worker = rig.startWorker({
    onRuntime: runtime => runtime.findResults.set(ID, { kind }),
  })
  await worker.composed.boot()
  await settle()
  return worker
}

describe('I-04 notice outbox survives the Worker restart', () => {
  it('a notice written before the restart is delivered once by the new Worker', async () => {
    await workerDyingReserved()
    const second = await rebootFinding('absent')

    expect(rig.notices()).toMatchObject([{ kind: 'failed_not_sent', state: 'pending' }])
    expect(second.runtimes[0].startedTurns).toHaveLength(0)

    await settle(2000)
    await settle()

    expect(second.control.deliveries).toHaveLength(1)
    expect(second.control.deliveries[0].text).toContain(`d=${ID.slice(0, 4)}`)
    expect(rig.notices()).toMatchObject([{ state: 'delivered' }])
    expect(rig.notices()[0].batchId).not.toBeNull()

    await settle(10_000)
    expect(second.control.deliveries).toHaveLength(1)
  })

  it('the same dedupe key from another boot does not duplicate the notice', async () => {
    await workerDyingReserved()
    const second = await rebootFinding('unknown')
    expect(rig.notices()).toMatchObject([{ kind: 'uncertain', state: 'pending' }])
    second.kill()

    const third = await rebootFinding('unknown')
    expect(rig.notices()).toHaveLength(1)
    expect(rig.notices()[0].kind).toBe('uncertain')

    await settle(2000)
    await settle()
    expect(third.control.deliveries).toHaveLength(1)
    expect(rig.notices()).toMatchObject([{ state: 'delivered' }])
  })

  it('a working orchestrator holds the batch until it goes idle', async () => {
    await workerDyingReserved()
    const second = await rebootFinding('absent')
    second.control.setRun({ state: 'working' })

    await settle(2000)
    expect(second.control.deliveries).toHaveLength(0)
    expect(rig.notices()).toMatchObject([{ state: 'pending' }])

    second.control.setRun({ state: 'idle' })
    await settle()
    expect(second.control.deliveries).toHaveLength(1)
    expect(rig.notices()).toMatchObject([{ state: 'delivered' }])
  })

  it('a recent typed write holds the batch until the 10 s quiet window ends', async () => {
    await workerDyingReserved()
    const second = await rebootFinding('absent')
    second.control.typedAt = Date.now()

    await settle(2000)
    expect(second.control.deliveries).toHaveLength(0)

    await settle(7999)
    expect(second.control.deliveries).toHaveLength(0)

    await settle(1)
    await settle()
    expect(second.control.deliveries).toHaveLength(1)
  })

  it('an uncertain delivery is not resent and shows as uncertain in the status', async () => {
    await workerDyingReserved()
    const second = await rebootFinding('absent')
    second.control.deliveryMode = 'uncertain'

    await settle(2000)
    await settle()
    expect(second.control.deliveries).toHaveLength(1)
    expect(rig.notices()).toMatchObject([{ state: 'uncertain' }])

    const status = await second.composed.service.status(AS_ORCHESTRATOR, { to: EXECUTOR_NODE })
    expect(status.links[0].notices).toEqual({ pending: 0, uncertain: 1 })

    await settle(10_000)
    expect(second.control.deliveries).toHaveLength(1)
    expect(rig.notices()).toMatchObject([{ state: 'uncertain' }])

    second.kill()
    const third = await rebootFinding('absent')
    await settle(2000)
    await settle()
    expect(third.control.deliveries).toHaveLength(0)
    expect(rig.notices()).toMatchObject([{ state: 'uncertain' }])
  })
})
