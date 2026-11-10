import type { PromptDeliveryService } from '../../../../contexts/agent/application/PromptDeliveryService'
import type { OrchestrationService } from '../../../../contexts/orchestration/application/OrchestrationService'
import { createNoticePump } from '../../../../contexts/orchestration/application/noticePump'
import type {
  AgentLinkRepository,
  Clock,
  DispatchRepository,
  ExecutorNodePort,
  IdGenerator,
  NoticeOutboxRepository,
  OrchestrationEventPublisher,
} from '../../../../contexts/orchestration/application/ports'
import { createSupervisor } from '../../../../contexts/orchestration/application/supervisor'
import type { SyncEventPayload } from '../../../../shared/contracts/dto/sync'
import { createOrchestratorDelivery } from './orchestratorDelivery'
import {
  createOrchestratorReadiness,
  type OrchestratorReadinessSources,
} from './orchestratorReadiness'
import {
  createOrchestrationLinksMirror,
  type OrchestrationLinksMirrorDeps,
} from './orchestrationLinksMirror'

export const NOTICE_DELIVERY_TIMEOUT_MS = 30_000

/** What the host provides to deliver notices to the orchestrator and to publish changes. */
export interface OrchestrationEventSources {
  readonly registry: OrchestratorReadinessSources['registry']
  readonly delivery: Pick<PromptDeliveryService, 'deliver'>
  readonly inputWatermark: OrchestratorReadinessSources['inputWatermark']
  readonly publish: (event: SyncEventPayload) => void
}

export type OrchestrationEventsService = Pick<
  OrchestrationService,
  'subscribeEvents' | 'subscribeHealth' | 'healthOf' | 'markExecutorUnavailable'
>

export interface OrchestrationEventsDeps {
  readonly links: Pick<
    AgentLinkRepository,
    'listActive' | 'readLinksRevision' | 'findActiveByExecutor'
  >
  readonly dispatches: Pick<DispatchRepository, 'findById'>
  readonly notices: Pick<NoticeOutboxRepository, 'enqueue' | 'listPending' | 'settleBatch'>
  readonly nodes: Pick<ExecutorNodePort, 'findNode'>
  readonly clock: Clock
  readonly ids: Pick<IdGenerator, 'uuid'>
  readonly schedule: OrchestratorReadinessSources['schedule']
  readonly log: (message: string, details: Record<string, string>) => void
  readonly writeMirror: OrchestrationLinksMirrorDeps['writeMirror']
  readonly readAppStateRevision: () => Promise<number>
  readonly sources: OrchestrationEventSources
}

export interface OrchestrationEvents {
  /** The publisher the service reports link changes to. */
  readonly events: OrchestrationEventPublisher
  /** Subscribes the supervisor, the health publication and the exhausted-restarts rule. */
  attach: (service: OrchestrationEventsService) => void
  idle: () => Promise<void>
  /** Rewrites the mirror and publishes it, as after a change of link. */
  sync: () => Promise<void>
  /** Asks the notice pump to look at its queue. */
  poke: (orchestratorNodeId: string) => void
  dispose: () => void
}

const RESTARTS_EXHAUSTED = 'restarts_exhausted'

/** Everything the Worker does with the events of the service: notices, mirror and health. */
export function createOrchestrationEvents(deps: OrchestrationEventsDeps): OrchestrationEvents {
  const { sources } = deps
  const onError = (error: unknown): void =>
    deps.log('orchestration event failed', { error: String(error) })
  const unsubscribers: (() => void)[] = []
  let attached: OrchestrationEventsService | null = null

  const delivery = createOrchestratorDelivery({
    service: sources.delivery,
    timeoutMs: NOTICE_DELIVERY_TIMEOUT_MS,
  })
  const pump = createNoticePump({
    notices: deps.notices,
    delivery,
    readiness: createOrchestratorReadiness({
      registry: sources.registry,
      inputWatermark: sources.inputWatermark,
      deliveryInFlight: delivery.inFlight,
      now: () => deps.clock.now().getTime(),
      schedule: deps.schedule,
    }),
    clock: deps.clock,
    ids: deps.ids,
    schedule: deps.schedule,
    onError,
  })
  const supervisor = createSupervisor({
    links: deps.links,
    dispatches: deps.dispatches,
    notices: deps.notices,
    nodes: deps.nodes,
    clock: deps.clock,
    ids: deps.ids,
    schedule: deps.schedule,
    onNotice: pump.poke,
    onError,
  })
  const mirror = createOrchestrationLinksMirror({
    links: deps.links,
    writeMirror: deps.writeMirror,
    publish: sources.publish,
    ids: deps.ids,
    readAppStateRevision: deps.readAppStateRevision,
    healthOf: link => attached?.healthOf(link.executorNodeId) ?? 'starting',
  })

  return {
    events: mirror,
    idle: () => mirror.idle(),
    sync: () => mirror.sync(),
    poke: pump.poke,
    attach(service) {
      attached = service
      const unavailable = new Set<string>()
      unsubscribers.push(
        service.subscribeEvents((executorNodeId, event) => {
          void supervisor.handle(executorNodeId, event)
          if (event.type === 'executor.down' && event.reason === RESTARTS_EXHAUSTED) {
            service.markExecutorUnavailable(executorNodeId).catch(onError)
          }
        }),
        service.subscribeHealth((executorNodeId, health) => {
          const isUnavailable = health === 'unavailable'
          if (isUnavailable === unavailable.has(executorNodeId)) {
            return
          }
          if (isUnavailable) {
            unavailable.add(executorNodeId)
          } else {
            unavailable.delete(executorNodeId)
          }
          mirror.sync().catch(onError)
        }),
      )
    },
    dispose() {
      unsubscribers.splice(0).forEach(unsubscribe => unsubscribe())
      supervisor.dispose()
      pump.dispose()
    },
  }
}
