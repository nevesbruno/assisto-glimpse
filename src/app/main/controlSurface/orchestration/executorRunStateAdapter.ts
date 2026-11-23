import type { AgentRunStateRegistry } from '../../../../contexts/agent/application/AgentRunStateRegistry'
import type {
  ExecutorRunStateIngress as ExecutorRunStateIngressPort,
  TurnCompletedRecord,
  TurnStartedRecord,
} from '../../../../contexts/orchestration/application/ports/hostPorts'
import type {
  ExecutorRuntimeEvent,
  ExecutorRuntimeProvider,
} from '../../../../contexts/orchestration/application/ports/executorRuntime'
import { ExecutorRunStateIngress } from './executorRunStateIngress'

export interface LiveExecutorSession {
  readonly sessionId: string
  readonly provider: ExecutorRuntimeProvider
  /** Changes whenever the executor session is replaced, so a stale instance is never reused. */
  readonly incarnation: string
}

export interface ExecutorRunStateAdapterDeps {
  /** `get` yields the turn id the registry minted, the same id `agent read --turn` accepts. */
  registry: Pick<AgentRunStateRegistry, 'register' | 'observe' | 'get'>
  /** Live run state session of the executor node, or null when there is none. */
  liveSessionOf: (executorNodeId: string) => LiveExecutorSession | null
  now: () => number
  /** Returns cancellation; same contract as the registry scheduler. */
  schedule: (callback: () => void, delayMs: number) => () => void
  /** Records are never dropped silently: an unroutable record is reported here. */
  log: (message: string, details: Record<string, string>) => void
}

export interface ExecutorRunStateAdapter extends ExecutorRunStateIngressPort {
  dispose: () => void
}

interface Bound {
  readonly session: LiveExecutorSession
  readonly ingress: ExecutorRunStateIngress
}

export function createExecutorRunStateAdapter(
  deps: ExecutorRunStateAdapterDeps,
): ExecutorRunStateAdapter {
  const bound = new Map<string, Bound>()

  const closeBound = (executorNodeId: string): void => {
    bound.get(executorNodeId)?.ingress.close()
    bound.delete(executorNodeId)
  }

  /** One instance per live session; a replaced session closes the old instance first. */
  const ingressOf = (executorNodeId: string): ExecutorRunStateIngress | null => {
    const session = deps.liveSessionOf(executorNodeId)
    const current = bound.get(executorNodeId)
    if (
      current &&
      session &&
      current.session.sessionId === session.sessionId &&
      current.session.incarnation === session.incarnation
    ) {
      return current.ingress
    }
    if (current) {
      closeBound(executorNodeId)
    }
    if (!session) {
      return null
    }
    const ingress = new ExecutorRunStateIngress(
      { registry: deps.registry, now: deps.now, schedule: deps.schedule },
      {
        sessionId: session.sessionId,
        executorNodeId,
        provider: session.provider,
        incarnation: session.incarnation,
      },
    )
    bound.set(executorNodeId, { session, ingress })
    return ingress
  }

  const needIngress = (executorNodeId: string, what: string): ExecutorRunStateIngress => {
    const ingress = ingressOf(executorNodeId)
    if (!ingress) {
      throw new Error(`No live session for executor node ${executorNodeId} (${what})`)
    }
    return ingress
  }

  const feed = (executorNodeId: string, what: string, event: ExecutorRuntimeEvent): void => {
    const ingress = ingressOf(executorNodeId)
    if (!ingress) {
      deps.log('executor run state record without live session', { executorNodeId, what })
      return
    }
    ingress.handle(event)
  }

  return {
    async recordTurnStarted(record: TurnStartedRecord) {
      needIngress(record.executorNodeId, 'turn started').handle({
        type: 'turn.started',
        turnRef: record.turnRef,
        dispatchId: null,
        origin: record.origin,
      })
      const sessionId = bound.get(record.executorNodeId)!.session.sessionId
      const glimpseTurnId = deps.registry.get({ sessionId })?.turn?.id
      if (!glimpseTurnId) {
        throw new Error(`Run state opened no turn for executor node ${record.executorNodeId}`)
      }
      return { glimpseTurnId }
    },

    async recordTurnCompleted(record: TurnCompletedRecord) {
      const ingress = needIngress(record.executorNodeId, 'turn completed')
      const sessionId = bound.get(record.executorNodeId)!.session.sessionId
      const active = deps.registry.get({ sessionId })?.turn?.id
      if (active !== record.glimpseTurnId) {
        deps.log('executor turn completed with unexpected glimpseTurnId', {
          executorNodeId: record.executorNodeId,
          expected: String(active),
          received: record.glimpseTurnId,
        })
      }
      ingress.handle({
        type: 'turn.completed',
        turnRef: record.turnRef,
        dispatchId: null,
        outcome: record.outcome,
        finalMessage: record.finalMessage,
        usage: null,
      })
    },

    async recordWaitingForApproval(executorNodeId, requestId, summary) {
      feed(executorNodeId, 'approval requested', {
        type: 'approval.requested',
        requestId,
        kind: 'permission',
        summary,
        turnRef: null,
      })
    },

    async recordApprovalResolved(executorNodeId, requestId) {
      feed(executorNodeId, 'approval resolved', {
        type: 'approval.resolved',
        requestId,
        resolvedBy: 'glimpse',
      })
    },

    async recordExecutorDown(executorNodeId) {
      feed(executorNodeId, 'executor down', {
        type: 'executor.down',
        reason: 'executor down',
        exitCode: null,
        signal: null,
      })
    },

    async recordExecutorRecovered(executorNodeId) {
      feed(executorNodeId, 'executor recovered', {
        type: 'executor.recovered',
        sessionRef: deps.liveSessionOf(executorNodeId)?.sessionId ?? '',
      })
    },

    dispose() {
      for (const executorNodeId of [...bound.keys()]) {
        closeBound(executorNodeId)
      }
    },
  }
}
