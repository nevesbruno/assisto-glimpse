import type { AgentRunStateRegistry } from '../../../../contexts/agent/application/AgentRunStateRegistry'
import type {
  OrchestratorReadiness,
  OrchestratorReadinessPort,
} from '../../../../contexts/orchestration/application/ports'

/** The PTY paste of a notice must not land in the middle of the user's typing. */
export const TYPING_QUIET_MS = 10_000

export interface OrchestratorReadinessSources {
  readonly registry: Pick<AgentRunStateRegistry, 'get' | 'subscribe'> & {
    list: () => { epoch: string; seq: number }
  }
  /** Instant of the last typed write of the session; automation pastes do not count. */
  readonly inputWatermark: (sessionId: string) => number | null
  readonly deliveryInFlight: (orchestratorNodeId: string) => boolean
  readonly now: () => number
  /** Returns the canceller, like the registry scheduler. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void
}

const sameReadiness = (a: OrchestratorReadiness, b: OrchestratorReadiness): boolean =>
  a.idle === b.idle && (a.idle || (b as typeof a).reason === a.reason)

/** Readiness of the orchestrator over the run state registry, with no polling. */
export function createOrchestratorReadiness(
  sources: OrchestratorReadinessSources,
): OrchestratorReadinessPort {
  const { registry } = sources

  function typingEndsAt(sessionId: string): number | null {
    const typedAt = sources.inputWatermark(sessionId)
    const endsAt = typedAt === null ? null : typedAt + TYPING_QUIET_MS
    return endsAt !== null && endsAt > sources.now() ? endsAt : null
  }

  function evaluate(orchestratorNodeId: string): OrchestratorReadiness {
    const snapshot = registry.get({ nodeId: orchestratorNodeId })
    if (!snapshot || snapshot.state === 'unknown' || snapshot.state === 'exited') {
      return { idle: false, reason: 'hook_stale' }
    }
    if (snapshot.state === 'working') {
      return { idle: false, reason: 'running' }
    }
    if (snapshot.state === 'waiting') {
      return { idle: false, reason: 'approval_open' }
    }
    if (snapshot.quality !== 'authoritative') {
      return { idle: false, reason: 'hook_stale' }
    }
    if (sources.deliveryInFlight(orchestratorNodeId)) {
      return { idle: false, reason: 'delivery_in_flight' }
    }
    return typingEndsAt(snapshot.sessionId) === null
      ? { idle: true }
      : { idle: false, reason: 'typing' }
  }

  return {
    readReadiness: async orchestratorNodeId => evaluate(orchestratorNodeId),
    watchReadiness(orchestratorNodeId, listener) {
      let last = evaluate(orchestratorNodeId)
      let cancelTimer: (() => void) | null = null

      const armTypingEnd = (): void => {
        cancelTimer?.()
        cancelTimer = null
        const sessionId = registry.get({ nodeId: orchestratorNodeId })?.sessionId
        const endsAt = sessionId ? typingEndsAt(sessionId) : null
        if (endsAt !== null) {
          cancelTimer = sources.schedule(check, endsAt - sources.now())
        }
      }

      function check(): void {
        const next = evaluate(orchestratorNodeId)
        if (next.idle || !sameReadiness(last, next)) {
          last = next
          listener(next)
        }
        armTypingEnd()
      }

      const { epoch, seq } = registry.list()
      const unsubscribe = registry.subscribe(
        { epoch, afterSeq: seq },
        { nodeId: orchestratorNodeId, state: 'idle' },
        check,
      )
      armTypingEnd()
      return () => {
        unsubscribe()
        cancelTimer?.()
        cancelTimer = null
      }
    },
  }
}
