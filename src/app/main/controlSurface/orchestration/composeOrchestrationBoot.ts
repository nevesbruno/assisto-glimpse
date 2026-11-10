import type { OrchestrationService } from '../../../../contexts/orchestration/application/OrchestrationService'
import type { AgentLinkRepository } from '../../../../contexts/orchestration/application/ports'
import type { OrchestrationEvents } from './composeOrchestrationEvents'

export interface OrchestrationBootDeps {
  readonly service: Pick<OrchestrationService, 'reconcileOnBoot' | 'relaunchExecutorTui'>
  readonly links: Pick<AgentLinkRepository, 'listActive'>
  readonly hasLiveTui: (executorNodeId: string) => boolean
  readonly events?: Pick<OrchestrationEvents, 'sync' | 'poke'>
  readonly log: (message: string, details: Record<string, string>) => void
  readonly isStopped: () => boolean
}

/**
 * The start of the Worker: reconciles the links, publishes the mirror, opens the pump and puts the
 * TUI back on every executor that has no PTY. A failure is logged and never stops the Worker.
 */
export function createOrchestrationBoot(deps: OrchestrationBootDeps): () => Promise<void> {
  const report = (error: unknown): void =>
    deps.log('orchestration boot step failed', { error: String(error) })
  return async () => {
    try {
      await deps.service.reconcileOnBoot()
      if (deps.isStopped()) {
        return
      }
      await deps.events?.sync()
      const links = await deps.links.listActive()
      for (const orchestratorNodeId of new Set(links.map(link => link.orchestratorNodeId))) {
        deps.events?.poke(orchestratorNodeId)
      }
      await Promise.all(
        links
          .filter(link => !deps.hasLiveTui(link.executorNodeId))
          .map(link =>
            deps.isStopped()
              ? undefined
              : deps.service.relaunchExecutorTui(link.executorNodeId).catch(report),
          ),
      )
    } catch (error) {
      report(error)
    }
  }
}
