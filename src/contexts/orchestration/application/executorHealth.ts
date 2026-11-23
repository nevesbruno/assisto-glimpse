import type { ExecutorHealth } from '../domain/dispatchAdmission'
import type { ExecutorRuntimeEvent } from './ports/executorRuntime'

export type { ExecutorHealth } from '../domain/dispatchAdmission'

/**
 * Signals that do not come from the runtime port. The supervisor of the process tells the
 * composition when it stops restarting, which `executor.down` alone cannot say.
 */
export type ServiceSignal =
  | { readonly type: 'service.starting' }
  | { readonly type: 'service.unavailable' }
  | { readonly type: 'reconciliation.finished' }

export type HealthSignal = ExecutorRuntimeEvent | ServiceSignal

export interface ExecutorHealthState {
  readonly ready: boolean
  readonly incident: boolean
  readonly degraded: boolean
  readonly unavailable: boolean
  readonly busy: boolean
}

export const INITIAL_EXECUTOR_HEALTH: ExecutorHealthState = {
  ready: false,
  incident: false,
  degraded: false,
  unavailable: false,
  busy: false,
}

function patch(state: ExecutorHealthState, change: Partial<ExecutorHealthState>) {
  return { ...state, ...change }
}

export function foldExecutorHealth(
  state: ExecutorHealthState,
  signal: HealthSignal,
): ExecutorHealthState {
  switch (signal.type) {
    case 'service.starting':
      return { ...INITIAL_EXECUTOR_HEALTH }
    case 'service.unavailable':
      return patch(state, { unavailable: true, busy: false })
    case 'reconciliation.finished':
      return patch(state, { incident: false })
    case 'executor.ready':
      return patch(state, { ready: true, degraded: false })
    case 'executor.degraded':
      return patch(state, { degraded: true })
    case 'executor.down':
      return patch(state, { ready: false, incident: true, degraded: false, busy: false })
    case 'executor.recovered':
      return patch(state, { incident: true, degraded: false })
    case 'turn.started':
      return patch(state, { busy: true })
    case 'turn.completed':
      return patch(state, { busy: false })
    default:
      return state
  }
}

/** Precedence: unavailable, starting, degraded, busy, ready. */
export function executorHealthOf(state: ExecutorHealthState): ExecutorHealth {
  if (state.unavailable) {
    return 'unavailable'
  }
  if (!state.ready || state.incident) {
    return 'starting'
  }
  if (state.degraded) {
    return 'degraded'
  }
  return state.busy ? 'busy' : 'ready'
}

export function deriveExecutorHealth(signals: readonly HealthSignal[]): ExecutorHealth {
  return executorHealthOf(signals.reduce(foldExecutorHealth, INITIAL_EXECUTOR_HEALTH))
}
