import { executorHealthOf } from './executorHealth'
import type { OrchestrationContext } from './OrchestrationService'
import { callRuntime, translateRuntimeError } from './runtimeErrors'
import { restartLinkedService } from './spawnExecutor'

/** Hands the TUI of the node the attach data of its running service; the slot must hold one. */
export async function attachTui(
  ctx: OrchestrationContext,
  executorNodeId: string,
  mode: 'launch' | 'relaunch',
): Promise<void> {
  const runtime = ctx.slotOf(executorNodeId).runtime!
  const attach = await callRuntime(() => runtime.attachInfo())
  await ctx.deps.tui[mode]({ executorNodeId, attach })
}

/** Puts the TUI of a service-mode executor back on its service; `false` when there is none to attach. */
export async function relaunchExecutorTuiOnSlot(
  ctx: OrchestrationContext,
  executorNodeId: string,
): Promise<boolean> {
  const link = await ctx.deps.links.findActiveByExecutor(executorNodeId)
  if (link?.runtimeMode !== 'service') {
    return false
  }
  const slot = ctx.slotOf(executorNodeId)
  if (!slot.runtime || executorHealthOf(slot.health) === 'unavailable') {
    await restartLinkedService(ctx, link).catch((error: unknown) => {
      ctx.onRuntimeEvent(slot, { type: 'service.unavailable' })
      throw translateRuntimeError(error)
    })
  }
  await attachTui(ctx, executorNodeId, 'relaunch')
  return true
}

export function relaunchExecutorTui(
  ctx: OrchestrationContext,
  executorNodeId: string,
): Promise<boolean> {
  return ctx.runExclusive(executorNodeId, () => relaunchExecutorTuiOnSlot(ctx, executorNodeId))
}
