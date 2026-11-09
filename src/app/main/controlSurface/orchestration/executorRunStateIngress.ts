import type { AgentRunStateRegistry } from '../../../../contexts/agent/application/AgentRunStateRegistry'
import type {
  ExecutorRuntimeEvent,
  ExecutorRuntimeProvider,
  TurnCompletionOutcome,
} from '../../../../contexts/orchestration/application/ports/executorRuntime'
import type {
  AgentRunObservation,
  TurnOutcome,
} from '../../../../contexts/agent/domain/agentRunState'

/** Renewal period of the working lease (`AGENT_HOOK_FRESHNESS_MS`, 180 s). */
export const EXECUTOR_LEASE_RENEWAL_MS = 60_000

const OUTCOMES: Record<TurnCompletionOutcome, TurnOutcome> = {
  completed: 'completed',
  failed: 'failed',
  interrupted: 'aborted',
}

type Registry = Pick<AgentRunStateRegistry, 'register' | 'observe'>

export interface ExecutorRunStateIngressPorts {
  registry: Registry
  now: () => number
  /** Returns cancellation; same contract as the registry scheduler. */
  schedule: (callback: () => void, delayMs: number) => () => void
}

export interface ExecutorRunStateIngressInput {
  sessionId: string
  executorNodeId: string
  provider: ExecutorRuntimeProvider
  incarnation: string
}

/** Turns executor events into run state observations of source `executor_service`. */
export class ExecutorRunStateIngress {
  private sequence = 0
  private lastObservedAt = -Infinity
  private working = false
  private readonly pendingApprovals = new Set<string>()
  private cancelRenewal: (() => void) | null = null

  constructor(
    private readonly ports: ExecutorRunStateIngressPorts,
    private readonly input: ExecutorRunStateIngressInput,
  ) {
    ports.registry.register({
      sessionId: input.sessionId,
      nodeId: input.executorNodeId,
      provider: input.provider,
      incarnation: input.incarnation,
    })
  }

  handle(event: ExecutorRuntimeEvent): void {
    switch (event.type) {
      case 'executor.ready':
      case 'executor.recovered':
        this.emit(this.workingState())
        if (this.working) {
          this.armRenewal()
        }
        break
      case 'turn.started':
        this.pendingApprovals.clear()
        this.working = true
        this.emit({ state: 'working', boundary: { kind: 'start', evidence: 'agent_start' } })
        this.armRenewal()
        break
      case 'approval.requested':
        this.pendingApprovals.add(event.requestId)
        this.emit(this.workingState())
        break
      case 'approval.resolved':
        this.pendingApprovals.delete(event.requestId)
        this.emit(this.workingState())
        break
      case 'turn.completed':
        this.working = false
        this.pendingApprovals.clear()
        this.disarmRenewal()
        this.emit(
          { state: 'idle', boundary: { kind: 'end', outcome: OUTCOMES[event.outcome] } },
          event.finalMessage === null
            ? undefined
            : { finalMessage: { message: event.finalMessage, truncated: false } },
        )
        break
      case 'executor.degraded':
      case 'executor.down':
        this.disarmRenewal()
        this.emit({ state: 'unknown', degraded: true })
        break
      default:
        break
    }
  }

  /** Link closed or node deleted: the session ends and no timer survives. */
  close(): void {
    this.disarmRenewal()
    this.working = false
    this.emit({ state: 'exited' }, undefined, 'exit')
  }

  private workingState(): Pick<AgentRunObservation, 'state' | 'blockedReason'> {
    if (!this.working) {
      return { state: 'idle' }
    }
    return this.pendingApprovals.size > 0
      ? { state: 'waiting', blockedReason: 'permission' }
      : { state: 'working' }
  }

  private armRenewal(): void {
    this.disarmRenewal()
    this.cancelRenewal = this.ports.schedule(() => {
      this.cancelRenewal = null
      if (!this.working) {
        return
      }
      this.emit(this.workingState())
      this.armRenewal()
    }, EXECUTOR_LEASE_RENEWAL_MS)
  }

  private disarmRenewal(): void {
    this.cancelRenewal?.()
    this.cancelRenewal = null
  }

  private emit(
    fields: Pick<AgentRunObservation, 'state'> & Partial<AgentRunObservation>,
    evidence?: { finalMessage: { message: string; truncated: boolean } },
    source: AgentRunObservation['source'] = 'executor_service',
  ): void {
    this.lastObservedAt = Math.max(this.lastObservedAt, this.ports.now())
    this.ports.registry.observe(
      this.input.sessionId,
      {
        incarnation: this.input.incarnation,
        source,
        observedAt: this.lastObservedAt,
        sourceSequence: ++this.sequence,
        ...fields,
      },
      evidence,
    )
  }
}
