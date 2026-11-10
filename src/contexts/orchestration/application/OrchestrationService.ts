/* oxlint-disable no-await-in-loop -- drains tails until no task was added meanwhile */
import { OrchestrationError, type AgentLink, type AgentLinkCloseReason } from '../domain/agentLink'
import {
  authorizeDirectInput,
  authorizeOrchestration,
  type DirectInputOperation,
  type OrchestrationOperation,
  type OrchestrationPrincipal,
} from '../domain/orchestrationAuthorization'
import type { RoundExtension } from '../domain/roundPolicy'
import { cancelDispatch, dispatchToExecutor, interruptExecutor } from './dispatchToExecutor'
import type { DispatchInput } from './dispatchToExecutor'
import { handleTurnEvent, pumpExecutor } from './dispatchPump'
import { executorHealthOf, foldExecutorHealth, type HealthSignal } from './executorHealth'
import {
  chainOnSlot,
  createSlot,
  isRoutedSignal,
  rememberSignal,
  type ExecutorSlot,
} from './executorSlots'
import { respondApproval, recordApprovalEvent, type RespondApprovalInput } from './approvals'
import { approveHooks, type ApproveHooksInput } from './hookApprovals'
import { closeExecutorLink, extendLinkRounds } from './linkLifecycle'
import type {
  AgentLinkRepository,
  Clock,
  DispatchLedger,
  DispatchRepository,
  ExecutorNodePort,
  OrchestrationEventPublisher,
  ExecutorRunStateIngress,
  ExecutorRuntimeEvent,
  ExecutorRuntimeFactory,
  ExecutorRuntimeProvider,
  ExecutorTuiLauncher,
  HookApprovalRepository,
  IdGenerator,
  NoticeOutboxRepository,
} from './ports'
import { handleExecutorIncident, reconcileOnBoot } from './reconcileOnBoot'
import { spawnExecutor, type SpawnInput } from './spawnExecutor'
import { buildStatus } from './statusView'

export interface OrchestrationDeps {
  readonly links: AgentLinkRepository
  readonly dispatches: DispatchRepository
  readonly ledger: DispatchLedger
  readonly notices: NoticeOutboxRepository
  readonly hookApprovals: HookApprovalRepository
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly nodes: ExecutorNodePort
  readonly tui: ExecutorTuiLauncher
  readonly runState: ExecutorRunStateIngress
  readonly events: OrchestrationEventPublisher
  readonly runtimeFactory: (provider: ExecutorRuntimeProvider) => ExecutorRuntimeFactory
  /** Ends services left by a previous Worker, found by pid and token hash. */
  readonly reapOrphanServices?: (links: readonly AgentLink[]) => Promise<void>
  readonly onBackgroundError?: (error: unknown) => void
}

export type { ExecutorSlot } from './executorSlots'
export type ExecutorEventListener = (executorNodeId: string, event: ExecutorRuntimeEvent) => void

export interface OrchestrationContext {
  readonly deps: OrchestrationDeps
  slotOf: (executorNodeId: string) => ExecutorSlot
  runExclusive: <T>(executorNodeId: string, task: () => Promise<T>) => Promise<T>
  wake: (executorNodeId: string) => void
  onRuntimeEvent: (slot: ExecutorSlot, signal: HealthSignal) => void
  bootDone: () => boolean
  finishBoot: () => Promise<void>
  authorize: (
    principal: OrchestrationPrincipal,
    operation: OrchestrationOperation,
    target: string | null,
  ) => Promise<void>
}

export class OrchestrationService {
  private readonly slots = new Map<string, ExecutorSlot>()
  private booted = false
  private readonly ctx: OrchestrationContext
  private readonly eventListeners = new Set<ExecutorEventListener>()

  public constructor(private readonly deps: OrchestrationDeps) {
    this.ctx = {
      deps,
      slotOf: id => this.slotOf(id),
      runExclusive: (id, task) => this.runExclusive(id, task),
      wake: id => this.background(() => pumpExecutor(this.ctx, id), id),
      onRuntimeEvent: (slot, signal) => this.onRuntimeEvent(slot, signal),
      bootDone: () => this.booted,
      finishBoot: () => this.finishBoot(),
      authorize: (principal, operation, target) => this.authorize(principal, operation, target),
    }
  }

  public spawn(principal: OrchestrationPrincipal, input: SpawnInput) {
    return spawnExecutor(this.ctx, principal, input)
  }

  public dispatch(principal: OrchestrationPrincipal, input: DispatchInput) {
    return dispatchToExecutor(this.ctx, principal, input)
  }

  public async status(principal: OrchestrationPrincipal, input: { to?: string }) {
    await this.authorize(principal, 'orch.status', input.to ?? null)
    return buildStatus(this.ctx, principal, input.to ?? null)
  }

  public cancel(principal: OrchestrationPrincipal, input: { dispatchId: string }) {
    return cancelDispatch(this.ctx, principal, input.dispatchId)
  }

  public interrupt(principal: OrchestrationPrincipal, input: { to: string }) {
    return interruptExecutor(this.ctx, principal, input.to)
  }

  public async close(principal: OrchestrationPrincipal, input: { to: string; force?: boolean }) {
    await this.authorize(principal, 'orch.close', input.to)
    return this.runExclusive(input.to, async () => {
      const link = await this.deps.links.findActiveByExecutor(input.to)
      if (!link) {
        throw new OrchestrationError('orch.not_linked')
      }
      const reason: AgentLinkCloseReason = principal.kind === 'user' ? 'user' : 'orchestrator'
      await closeExecutorLink(this.ctx, link, reason, input.force ?? false)
    })
  }

  public async extendRounds(
    principal: OrchestrationPrincipal,
    input: { linkId: string; rounds: RoundExtension },
  ) {
    await this.authorize(principal, 'orch.link.extend', null)
    return extendLinkRounds(this.ctx, input.linkId, input.rounds)
  }

  /** The supervisor gave up restarting: the pump it wakes fails queued work and ends the open turn. */
  public markExecutorUnavailable(executorNodeId: string): Promise<void> {
    this.onRuntimeEvent(this.slotOf(executorNodeId), { type: 'service.unavailable' })
    return this.whenIdle()
  }

  /** Publishes each routed event after the service handled it; returns the canceller. */
  public subscribeEvents(listener: ExecutorEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  public respondApproval(principal: OrchestrationPrincipal, input: RespondApprovalInput) {
    return respondApproval(this.ctx, principal, input)
  }

  public approveHooks(principal: OrchestrationPrincipal, input: ApproveHooksInput) {
    return approveHooks(this.ctx, principal, input)
  }

  /** Restart reconciliation of the links; ends by opening the pump through `finishBoot`. */
  public reconcileOnBoot(): Promise<void> {
    return reconcileOnBoot(this.ctx)
  }

  /** Opens the pump once the boot work is done. */
  public async finishBoot(): Promise<void> {
    this.booted = true
    for (const link of await this.deps.links.listActive()) {
      this.ctx.wake(link.executorNodeId)
    }
  }

  public async assertDirectInput(
    principal: OrchestrationPrincipal,
    operation: DirectInputOperation,
    targetNodeId: string,
  ): Promise<void> {
    const result = authorizeDirectInput({
      principal,
      operation,
      targetNodeId,
      links: await this.deps.links.listActive(),
    })
    if (!result.allowed) {
      throw new OrchestrationError(result.code)
    }
  }

  public async whenIdle(): Promise<void> {
    let tails: Promise<unknown>[]
    do {
      tails = [...this.slots.values()].map(slot => slot.tail)
      await Promise.all(tails)
    } while ([...this.slots.values()].some((slot, index) => slot.tail !== tails[index]))
  }

  private slotOf(executorNodeId: string): ExecutorSlot {
    let slot = this.slots.get(executorNodeId)
    if (!slot) {
      slot = createSlot(executorNodeId)
      this.slots.set(executorNodeId, slot)
    }
    return slot
  }

  private runExclusive<T>(executorNodeId: string, task: () => Promise<T>): Promise<T> {
    return chainOnSlot(this.slotOf(executorNodeId), task)
  }

  private background(task: () => Promise<void>, executorNodeId: string): void {
    this.runExclusive(executorNodeId, task).catch(error => this.deps.onBackgroundError?.(error))
  }

  /** One rule for waking the pump: any change of the derived health, whatever the signal. */
  private onRuntimeEvent(slot: ExecutorSlot, signal: HealthSignal): void {
    const before = executorHealthOf(slot.health)
    slot.health = foldExecutorHealth(slot.health, signal)
    if (isRoutedSignal(signal)) {
      rememberSignal(slot, signal)
      this.background(() => this.routeEvent(slot, signal), slot.executorNodeId)
    }
    if (executorHealthOf(slot.health) !== before) {
      this.ctx.wake(slot.executorNodeId)
    }
  }

  private async routeEvent(slot: ExecutorSlot, event: ExecutorRuntimeEvent): Promise<void> {
    await this.handleRoutedEvent(slot, event)
    for (const listener of [...this.eventListeners]) {
      listener(slot.executorNodeId, event)
    }
  }

  private async handleRoutedEvent(slot: ExecutorSlot, event: ExecutorRuntimeEvent): Promise<void> {
    if (event.type === 'executor.down' || event.type === 'executor.recovered') {
      await handleExecutorIncident(this.ctx, slot, event)
      await pumpExecutor(this.ctx, slot.executorNodeId)
      return
    }
    await recordApprovalEvent(this.ctx, slot, event)
    await handleTurnEvent(this.ctx, slot, event)
  }

  private async authorize(
    principal: OrchestrationPrincipal,
    operation: OrchestrationOperation,
    targetExecutorNodeId: string | null,
  ): Promise<void> {
    const result = authorizeOrchestration({
      principal,
      operation,
      targetExecutorNodeId,
      links: await this.deps.links.listActive(),
    })
    if (!result.allowed) {
      throw new OrchestrationError(result.code)
    }
  }
}
