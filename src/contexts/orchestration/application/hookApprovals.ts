import { OrchestrationError } from '../domain/agentLink'
import type { OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import { createAppError } from '../../../shared/errors/appError'
import { executorHealthOf } from './executorHealth'
import type { ExecutorSlot, OrchestrationContext } from './OrchestrationService'
import { restartLinkedService } from './spawnExecutor'

export interface ApproveHooksInput {
  readonly executorNodeId: string
  readonly keys: readonly string[]
}

export interface ApproveHooksResult {
  readonly approved: number
  readonly restart: 'done' | 'scheduled'
}

async function isIdle(ctx: OrchestrationContext, slot: ExecutorSlot): Promise<boolean> {
  return (
    executorHealthOf(slot.health) === 'ready' &&
    !(await ctx.deps.dispatches.findInFlightByExecutor(slot.executorNodeId))
  )
}

/** Restarts the service so it reads the new approvals, only when the executor is idle. */
export async function restartIfIdle(
  ctx: OrchestrationContext,
  slot: ExecutorSlot,
): Promise<boolean> {
  const link = await ctx.deps.links.findActiveByExecutor(slot.executorNodeId)
  if (!slot.restartPending || !slot.runtime || !link || !(await isIdle(ctx, slot))) {
    return false
  }
  slot.restartPending = false
  const previous = slot.runtime
  slot.unsubscribe?.()
  slot.unsubscribe = null
  slot.runtime = null
  await previous.close('restart')
  try {
    await restartLinkedService(ctx, link)
    const attach = await slot.runtime!.attachInfo()
    await ctx.deps.tui.relaunch({ executorNodeId: slot.executorNodeId, attach })
  } catch {
    ctx.onRuntimeEvent(slot, { type: 'service.unavailable' })
    throw new OrchestrationError('orch.executor_unavailable')
  }
  return true
}

export async function approveHooks(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  input: ApproveHooksInput,
): Promise<ApproveHooksResult> {
  await ctx.authorize(principal, 'orch.hooks.approve', input.executorNodeId)
  const { executorNodeId } = input
  if (!(await ctx.deps.links.findActiveByExecutor(executorNodeId))) {
    throw new OrchestrationError('orch.not_linked')
  }
  return ctx.runExclusive(executorNodeId, async () => {
    const slot = ctx.slotOf(executorNodeId)
    const keys = [...new Set(input.keys)]
    const pending = new Map(slot.pendingHooks.map(hook => [hook.key, hook]))
    const outside = keys.filter(key => !pending.has(key))
    if (outside.length > 0) {
      throw createAppError('common.invalid_input', {
        debugMessage: `hook keys not pending: ${outside.join(', ')}`,
      })
    }
    const approvedAt = ctx.deps.clock.now().toISOString()
    await ctx.deps.hookApprovals.record(
      keys.map(key => {
        const hook = pending.get(key)!
        return {
          key,
          currentHash: hook.currentHash,
          eventName: hook.event,
          sourcePath: hook.origin,
          approvedAt,
          approvedBy: 'user',
        }
      }),
    )
    slot.restartPending = true
    const done = await restartIfIdle(ctx, slot)
    return { approved: keys.length, restart: done ? 'done' : 'scheduled' }
  })
}
