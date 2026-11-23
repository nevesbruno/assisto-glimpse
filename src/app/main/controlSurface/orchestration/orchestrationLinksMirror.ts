import type {
  AgentLinkRepository,
  IdGenerator,
  OrchestrationEventPublisher,
} from '../../../../contexts/orchestration/application/ports'
import type { AgentLink } from '../../../../contexts/orchestration/domain/agentLink'
import type {
  OrchestrationLinkDto,
  OrchestrationLinkHealth,
  OrchestrationLinksMirror,
} from '../../../../shared/contracts/dto/orchestration'
import type { SyncEventPayload } from '../../../../shared/contracts/dto/sync'

export interface OrchestrationLinksMirrorDeps {
  readonly links: Pick<AgentLinkRepository, 'listActive' | 'readLinksRevision'>
  readonly writeMirror: (mirror: OrchestrationLinksMirror) => void
  readonly publish: (event: SyncEventPayload) => void
  readonly ids: Pick<IdGenerator, 'uuid'>
  readonly readAppStateRevision: () => Promise<number>
  readonly healthOf: (link: AgentLink) => OrchestrationLinkHealth
}

export interface OrchestrationLinksMirrorWriter extends OrchestrationEventPublisher {
  /** Rebuilds the mirror from the Worker table and, by default, publishes one event for it. */
  sync: (options?: { publish?: boolean }) => Promise<void>
  /** Resolves when every queued `sync` has finished. */
  idle: () => Promise<void>
}

function toLinkDto(link: AgentLink, health: OrchestrationLinkHealth): OrchestrationLinkDto {
  return {
    id: link.id,
    projectId: link.projectId,
    spaceId: link.spaceId,
    orchestratorNodeId: link.orchestratorNodeId,
    executorNodeId: link.executorNodeId,
    kind: link.kind,
    origin: link.origin,
    runtimeMode: link.runtimeMode,
    provider: link.provider,
    state: link.state,
    closeReason: link.closeReason,
    health,
    roundsUsed: link.roundsUsed,
    roundsLimit: link.roundsLimit,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    revision: link.revision,
  }
}

/**
 * Display mirror of the Worker links table. Dispatch reach never reads it: a window can forge the
 * synced copy, and the next `sync` overwrites it.
 */
export function createOrchestrationLinksMirror(
  deps: OrchestrationLinksMirrorDeps,
): OrchestrationLinksMirrorWriter {
  let queue: Promise<void> = Promise.resolve()

  async function syncNow(shouldPublish: boolean): Promise<void> {
    const [links, linksRevision] = await Promise.all([
      deps.links.listActive(),
      deps.links.readLinksRevision(),
    ])
    deps.writeMirror({
      linksRevision,
      links: links.map(link => toLinkDto(link, deps.healthOf(link))),
    })
    if (shouldPublish) {
      deps.publish({
        type: 'orchestration.links.updated',
        revision: await deps.readAppStateRevision(),
        linksRevision,
        operationId: deps.ids.uuid(),
      })
    }
  }

  function enqueue(shouldPublish: boolean): Promise<void> {
    const run = queue.then(() => syncNow(shouldPublish))
    queue = run.catch(() => undefined)
    return run
  }

  return {
    sync: options => enqueue(options?.publish !== false),
    idle: () => queue,
    publishLinksUpdated: () => {
      void enqueue(true).catch(() => undefined)
    },
  }
}
