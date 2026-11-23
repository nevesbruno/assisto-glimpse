import { describe, expect, it } from 'vitest'
import {
  deriveExecutorHealth,
  foldExecutorHealth,
  INITIAL_EXECUTOR_HEALTH,
  type ExecutorHealth,
  type HealthSignal,
} from '../../../../../src/contexts/orchestration/application/executorHealth'
import type { OrchestrationLinkHealth } from '../../../../../src/shared/contracts/dto/orchestration'

const ready: HealthSignal = {
  type: 'executor.ready',
  sessionRef: 's',
  resumed: false,
  version: '1',
}
const turnStarted = (origin: 'glimpse' | 'screen'): HealthSignal => ({
  type: 'turn.started',
  turnRef: 't',
  dispatchId: null,
  origin,
})
const turnCompleted: HealthSignal = {
  type: 'turn.completed',
  turnRef: 't',
  dispatchId: null,
  outcome: 'completed',
  finalMessage: null,
  usage: null,
}
const degraded: HealthSignal = { type: 'executor.degraded', reason: 'slow' }
const down: HealthSignal = { type: 'executor.down', reason: 'exit', exitCode: 1, signal: null }
const recovered: HealthSignal = { type: 'executor.recovered', sessionRef: 's' }
const starting: HealthSignal = { type: 'service.starting' }
const unavailable: HealthSignal = { type: 'service.unavailable' }
const reconciled: HealthSignal = { type: 'reconciliation.finished' }

describe('executorHealth (ADR table)', () => {
  it('starts as starting and executor.ready makes it ready', () => {
    expect(deriveExecutorHealth([])).toBe('starting')
    expect(deriveExecutorHealth([ready])).toBe('ready')
  })

  it('turn.started is busy until turn.completed, for glimpse and screen origins', () => {
    for (const origin of ['glimpse', 'screen'] as const) {
      expect(deriveExecutorHealth([ready, turnStarted(origin)])).toBe('busy')
      expect(deriveExecutorHealth([ready, turnStarted(origin), turnCompleted])).toBe('ready')
    }
  })

  it('executor.degraded holds until the next ready or recovered', () => {
    expect(deriveExecutorHealth([ready, degraded])).toBe('degraded')
    expect(deriveExecutorHealth([ready, degraded, ready])).toBe('ready')
    expect(deriveExecutorHealth([ready, degraded, recovered, ready, reconciled])).toBe('ready')
    expect(deriveExecutorHealth([ready, degraded, recovered])).toBe('starting')
  })

  it('executor.down with a scheduled restart is starting and opens the incident', () => {
    expect(deriveExecutorHealth([ready, down])).toBe('starting')
    expect(deriveExecutorHealth([ready, down, ready])).toBe('starting')
  })

  it('executor.down without restart is unavailable and beats every other state', () => {
    expect(deriveExecutorHealth([ready, down, unavailable])).toBe('unavailable')
    expect(deriveExecutorHealth([ready, down, unavailable, ready, degraded])).toBe('unavailable')
    expect(deriveExecutorHealth([ready, turnStarted('screen'), down, unavailable])).toBe(
      'unavailable',
    )
  })

  it('a new service start leaves unavailable and starts again', () => {
    expect(deriveExecutorHealth([ready, down, unavailable, starting])).toBe('starting')
    expect(deriveExecutorHealth([ready, down, unavailable, starting, ready])).toBe('ready')
  })

  it('recovered stays starting until the reconciliation ends, then ready or busy', () => {
    expect(deriveExecutorHealth([ready, down, recovered, ready])).toBe('starting')
    expect(deriveExecutorHealth([ready, down, recovered, ready, reconciled])).toBe('ready')
    expect(
      deriveExecutorHealth([ready, down, recovered, ready, turnStarted('screen'), reconciled]),
    ).toBe('busy')
  })

  it('accepts recovered before ready with the same final result', () => {
    const readyFirst = [ready, down, ready, recovered, reconciled]
    const recoveredFirst = [ready, down, recovered, ready, reconciled]
    expect(deriveExecutorHealth(readyFirst)).toBe('ready')
    expect(deriveExecutorHealth(recoveredFirst)).toBe('ready')
  })

  it('precedence is unavailable, starting, degraded, busy, ready', () => {
    expect(deriveExecutorHealth([ready, turnStarted('screen'), degraded])).toBe('degraded')
    expect(deriveExecutorHealth([ready, turnStarted('screen'), starting])).toBe('starting')
    expect(deriveExecutorHealth([ready, degraded, starting])).toBe('starting')
  })

  it('a restart clears a busy turn that died with the service', () => {
    expect(deriveExecutorHealth([ready, turnStarted('glimpse'), down, ready, recovered])).toBe(
      'starting',
    )
    expect(
      deriveExecutorHealth([ready, turnStarted('glimpse'), down, ready, recovered, reconciled]),
    ).toBe('ready')
  })

  it('ignores events that carry no health information', () => {
    const noise: HealthSignal = { type: 'hooks.trust_pending', hooks: [] }
    expect(foldExecutorHealth(INITIAL_EXECUTOR_HEALTH, noise)).toBe(INITIAL_EXECUTOR_HEALTH)
  })

  it('shares one list with the domain and the DTO (compile time)', () => {
    const health: ExecutorHealth = deriveExecutorHealth([ready])
    const dto: OrchestrationLinkHealth = health
    const back: ExecutorHealth = dto
    expect(back).toBe('ready')
  })
})
