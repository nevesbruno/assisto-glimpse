import type { OrchestrationService } from '../../../../contexts/orchestration/application/OrchestrationService'
import type { AgentLinkRepository } from '../../../../contexts/orchestration/application/ports'
import type { OrchestrationEvents } from './composeOrchestrationEvents'

/** Backoff of the degraded boot; the last value repeats while the dependency stays away. */
export const BOOT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const

export interface OrchestrationBootDeps {
  readonly service: Pick<OrchestrationService, 'reconcileOnBoot' | 'relaunchExecutorTui'>
  readonly links: Pick<AgentLinkRepository, 'listActive'>
  readonly hasLiveTui: (executorNodeId: string) => boolean
  readonly events?: Pick<OrchestrationEvents, 'sync' | 'poke'>
  readonly log: (message: string, details: Record<string, string>) => void
  readonly isStopped: () => boolean
  /** Resolves once the schema exists: the PersistenceStore creates it, lazily, on first request. */
  readonly ready?: () => Promise<unknown>
  /** Returns the canceller, like the Worker scheduler. Without it the boot does not retry. */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void
  readonly retryDelaysMs?: readonly number[]
}

/**
 * The start of the Worker: reconciles the links, publishes the mirror, opens the pump and puts the
 * TUI back on every executor that has no PTY. Every step is isolated: an unavailable executor
 * degrades the boot and schedules a retry, and never aborts it.
 */
export function createOrchestrationBoot(deps: OrchestrationBootDeps): () => Promise<void> {
  const report = (error: unknown): void =>
    deps.log('orchestration boot step failed', { error: String(error) })
  const delays = deps.retryDelaysMs ?? BOOT_RETRY_DELAYS_MS
  let attempts = 0
  let cancelRetry: (() => void) | null = null

  const scheduleRetry = (): void => {
    if (!deps.schedule || delays.length === 0 || deps.isStopped()) {
      return
    }
    const delayMs = delays[Math.min(attempts, delays.length - 1)]
    attempts += 1
    deps.log('orchestration boot retry scheduled', { delayMs: String(delayMs) })
    cancelRetry = deps.schedule(() => {
      cancelRetry = null
      void run()
    }, delayMs)
  }

  async function run(): Promise<void> {
    cancelRetry?.()
    cancelRetry = null
    if (deps.isStopped()) {
      return
    }
    let failed = false
    const step = async (task: () => Promise<void>): Promise<void> => {
      if (deps.isStopped()) {
        return
      }
      try {
        await task()
      } catch (error) {
        failed = true
        report(error)
      }
    }
    try {
      await step(async () => {
        await deps.ready?.()
      })
      await step(() => deps.service.reconcileOnBoot())
      await step(async () => {
        await deps.events?.sync()
      })
      await step(async () => {
        const links = await deps.links.listActive()
        for (const orchestratorNodeId of new Set(links.map(link => link.orchestratorNodeId))) {
          deps.events?.poke(orchestratorNodeId)
        }
        await Promise.allSettled(
          links
            .filter(link => !deps.hasLiveTui(link.executorNodeId))
            .map(link =>
              deps.isStopped()
                ? undefined
                : deps.service.relaunchExecutorTui(link.executorNodeId).catch(error => {
                    failed = true
                    report(error)
                  }),
            ),
        )
      })
    } finally {
      if (!deps.isStopped()) {
        if (failed) {
          scheduleRetry()
        } else {
          attempts = 0
        }
      }
    }
  }

  return run
}
