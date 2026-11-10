import type { AgentLink } from '../domain/agentLink'
import type { NoticeEntry, NoticeKind } from '../domain/noticeComposer'
import type {
  AgentLinkRepository,
  Clock,
  DispatchRepository,
  ExecutorNodePort,
  ExecutorRuntimeEvent,
  IdGenerator,
  NoticeOutboxRepository,
} from './ports'

export const APPROVAL_NOTICE_DELAY_MS = 120_000

export interface SupervisorDeps {
  readonly links: Pick<AgentLinkRepository, 'findActiveByExecutor'>
  readonly dispatches: Pick<DispatchRepository, 'findById'>
  readonly notices: Pick<NoticeOutboxRepository, 'enqueue'>
  readonly nodes: Pick<ExecutorNodePort, 'findNode'>
  readonly clock: Clock
  readonly ids: Pick<IdGenerator, 'uuid'>
  /** Returns the canceller, like the registry scheduler. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void
  /** Called after any event of a linked executor, so the pump looks at the outbox. */
  readonly onNotice: (orchestratorNodeId: string) => void
  readonly approvalDelayMs?: number
  readonly onError?: (error: unknown) => void
}

export interface Supervisor {
  handle: (executorNodeId: string, event: ExecutorRuntimeEvent) => Promise<void>
  dispose: () => void
}

interface NoticeSpec {
  readonly kind: NoticeKind
  readonly dedupeKey: string
  readonly dispatchId?: string
}

/** Turns executor events and deadlines into outbox notices; the settle of a dispatch writes its own. */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const timers = new Map<string, () => void>()
  const incidents = new Map<string, number>()
  const approvalDelayMs = deps.approvalDelayMs ?? APPROVAL_NOTICE_DELAY_MS

  const cancel = (key: string): void => {
    timers.get(key)?.()
    timers.delete(key)
  }

  async function enqueue(link: AgentLink, spec: NoticeSpec): Promise<void> {
    const dispatch = spec.dispatchId ? await deps.dispatches.findById(spec.dispatchId) : null
    const node = await deps.nodes.findNode(link.executorNodeId)
    const createdAt = deps.clock.now().toISOString()
    const entry: NoticeEntry = {
      executorNodeId: link.executorNodeId,
      executorName: node?.title ?? link.executorNodeId,
      provider: link.provider,
      kind: spec.kind,
      round: dispatch?.round ?? null,
      roundsLimit: dispatch ? link.roundsLimit : null,
      dispatchId: spec.dispatchId ?? null,
      glimpseTurnId: null,
      excerpt: null,
      createdAt,
    }
    await deps.notices.enqueue({
      id: deps.ids.uuid(),
      orchestratorNodeId: link.orchestratorNodeId,
      dedupeKey: spec.dedupeKey,
      entry,
      state: 'pending',
      batchId: null,
      createdAt,
      settledAt: null,
    })
  }

  function arm(link: AgentLink, timerKey: string, delayMs: number, spec: NoticeSpec): void {
    if (timers.has(timerKey)) {
      return
    }
    timers.set(
      timerKey,
      deps.schedule(() => {
        timers.delete(timerKey)
        enqueue(link, spec)
          .then(() => deps.onNotice(link.orchestratorNodeId))
          .catch(error => deps.onError?.(error))
      }, delayMs),
    )
  }

  async function armDeadline(link: AgentLink, dispatchId: string): Promise<void> {
    const dispatch = await deps.dispatches.findById(dispatchId)
    if (dispatch?.state !== 'sent') {
      return
    }
    const delayMs = Math.max(0, Date.parse(dispatch.deadlineAt) - deps.clock.now().getTime())
    arm(link, `deadline:${dispatchId}`, delayMs, {
      kind: 'deadline_exceeded',
      dedupeKey: `${dispatchId}:deadline`,
      dispatchId,
    })
  }

  async function react(link: AgentLink, event: ExecutorRuntimeEvent): Promise<void> {
    const id = link.executorNodeId
    switch (event.type) {
      case 'approval.requested':
        arm(link, `approval:${id}:${event.requestId}`, approvalDelayMs, {
          kind: 'approval_unanswered',
          dedupeKey: `approval:${id}:${event.requestId}`,
        })
        return
      case 'approval.resolved':
        cancel(`approval:${id}:${event.requestId}`)
        return
      case 'executor.down':
        await enqueue(link, {
          kind: 'executor_down',
          dedupeKey: `down:${id}:${incidents.get(id) ?? 0}`,
        })
        return
      case 'executor.recovered':
        incidents.set(id, (incidents.get(id) ?? 0) + 1)
        return
      case 'turn.started':
        if (event.dispatchId) {
          await armDeadline(link, event.dispatchId)
        }
        return
      case 'turn.completed':
        if (event.dispatchId) {
          cancel(`deadline:${event.dispatchId}`)
        }
        return
      default:
    }
  }

  return {
    async handle(executorNodeId, event) {
      try {
        const link = await deps.links.findActiveByExecutor(executorNodeId)
        if (link) {
          await react(link, event)
          deps.onNotice(link.orchestratorNodeId)
        }
      } catch (error) {
        deps.onError?.(error)
      }
    },
    dispose() {
      for (const key of [...timers.keys()]) {
        cancel(key)
      }
    },
  }
}
