import type { ExecutorSlot } from './executorSlots'
import type { OrchestrationContext } from './OrchestrationService'

/**
 * Stops every running service as the Worker stops: cuts the slot off from its events first, so the
 * closing is never read as a crash. Links stay active and the next boot resumes the threads.
 */
export async function shutdownExecutors(
  ctx: OrchestrationContext,
  slots: readonly ExecutorSlot[],
): Promise<void> {
  await Promise.all(
    slots.map(slot =>
      ctx
        .runExclusive(slot.executorNodeId, async () => {
          const { runtime } = slot
          slot.unsubscribe?.()
          slot.unsubscribe = null
          slot.runtime = null
          await runtime?.close('shutdown')
        })
        .catch(error => ctx.deps.onBackgroundError?.(error)),
    ),
  )
}
