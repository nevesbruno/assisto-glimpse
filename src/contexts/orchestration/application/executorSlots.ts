import {
  INITIAL_EXECUTOR_HEALTH,
  type ExecutorHealthState,
  type HealthSignal,
} from './executorHealth'
import type { ExecutorRuntime, ExecutorRuntimeEvent, HookTrustPending } from './ports'

export interface ExecutorSlot {
  readonly executorNodeId: string
  runtime: ExecutorRuntime | null
  unsubscribe: (() => void) | null
  health: ExecutorHealthState
  tail: Promise<unknown>
  /** `turnRef` to the turn id of the run state. */
  readonly turns: Map<string, string>
  readonly pendingApprovals: Set<string>
  pendingHooks: readonly HookTrustPending[]
  /** Hooks were approved and the service has not restarted to read them yet. */
  restartPending: boolean
}

/** Signals that carry something to handle; whether the pump wakes is decided by the health change. */
const ROUTED_SIGNAL_TYPES = new Set<string>([
  'executor.ready',
  'turn.started',
  'turn.completed',
  'approval.requested',
  'approval.resolved',
  'hooks.trust_pending',
  'executor.down',
  'executor.recovered',
] satisfies ExecutorRuntimeEvent['type'][])

export function isRoutedSignal(signal: HealthSignal): signal is ExecutorRuntimeEvent {
  return ROUTED_SIGNAL_TYPES.has(signal.type)
}

export function createSlot(executorNodeId: string): ExecutorSlot {
  return {
    executorNodeId,
    runtime: null,
    unsubscribe: null,
    health: INITIAL_EXECUTOR_HEALTH,
    tail: Promise.resolve(),
    turns: new Map(),
    pendingApprovals: new Set(),
    pendingHooks: [],
    restartPending: false,
  }
}

/** Keeps what the status shows, which is the part of a signal the slot itself remembers. */
export function rememberSignal(slot: ExecutorSlot, signal: ExecutorRuntimeEvent): void {
  if (signal.type === 'approval.requested') {
    slot.pendingApprovals.add(signal.requestId)
  } else if (signal.type === 'approval.resolved') {
    slot.pendingApprovals.delete(signal.requestId)
  } else if (signal.type === 'hooks.trust_pending') {
    slot.pendingHooks = signal.hooks
  }
}

/** Runs the task after everything queued before it on the slot, failures included. */
export function chainOnSlot<T>(slot: ExecutorSlot, task: () => Promise<T>): Promise<T> {
  const result = slot.tail.then(task)
  slot.tail = result.catch(() => undefined)
  return result
}
