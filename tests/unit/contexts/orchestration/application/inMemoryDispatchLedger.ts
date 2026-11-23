import type {
  AcceptDispatchResult,
  AcceptRefusal,
  CreateLinkWithDispatchResult,
  DispatchLedger,
  SettleDispatchInput,
  SettleDispatchResult,
} from '../../../../../src/contexts/orchestration/application/ports'
import type { AgentLink } from '../../../../../src/contexts/orchestration/domain/agentLink'
import type { Dispatch } from '../../../../../src/contexts/orchestration/domain/dispatch'
import { isFinalDispatchState } from '../../../../../src/contexts/orchestration/domain/dispatch'
import type { InMemoryDispatches, InMemoryLinks, InMemoryNotices } from './fakes'

class Refusal extends Error {
  public constructor(public readonly reason: string) {
    super(reason)
  }
}

/** The same rules as `SqliteDispatchLedger`, undone by snapshot when a step throws. */
export class InMemoryDispatchLedger implements DispatchLedger {
  /** Fails the next step after its first writes, as a crash in the middle would. */
  public failAt: 'accept' | 'settle' | null = null

  public constructor(
    private readonly links: InMemoryLinks,
    private readonly dispatches: InMemoryDispatches,
    private readonly notices: InMemoryNotices,
  ) {}

  public async acceptDispatch(dispatch: Dispatch): Promise<AcceptDispatchResult> {
    const result = this.atomically(() => this.acceptStep(dispatch))
    return 'ok' in result ? result : { ok: true, ...result }
  }

  public async createLinkWithDispatch(
    link: AgentLink,
    dispatch: Dispatch | null,
  ): Promise<CreateLinkWithDispatchResult> {
    const result = this.atomically(() => {
      const inserted = this.insertLink(link)
      if (!inserted.ok) {
        throw new Refusal(inserted.reason)
      }
      return dispatch ? this.acceptStep(dispatch) : { dispatch: null, link }
    })
    return 'ok' in result ? result : { ok: true, ...result }
  }

  public async settleDispatch(input: SettleDispatchInput): Promise<SettleDispatchResult> {
    const { next, refundRound, notice, at } = input
    const result = this.atomically(() => {
      if (next.state === 'reserved' && this.dispatches.hasOtherInFlight(next)) {
        throw new Refusal('in_flight_conflict')
      }
      const stored = this.dispatches.rows.get(next.id)
      if (!stored) {
        throw new Refusal('not_found')
      }
      if (next.revision !== stored.revision + 1) {
        throw new Refusal('revision_conflict')
      }
      this.dispatches.rows.set(next.id, next)
      const link = this.links.rows.get(next.linkId)
      if (refundRound && link) {
        this.writeLink({ ...link, roundsUsed: Math.max(0, link.roundsUsed - 1) }, at)
      }
      this.failIf('settle')
      const queued = notice ? !this.notices.rows.some(r => r.dedupeKey === notice.dedupeKey) : false
      if (notice && queued) {
        this.notices.rows.push(notice)
      }
      return {
        dispatch: next,
        link: this.links.rows.get(next.linkId) ?? null,
        noticeEnqueued: queued,
      }
    })
    return 'ok' in result ? result : { ok: true, ...result }
  }

  private insertLink(link: AgentLink) {
    const rows = [...this.links.rows.values()]
    if (rows.some(r => r.id === link.id)) {
      return { ok: false, reason: 'id_exists' } as const
    }
    if (
      link.state === 'active' &&
      rows.some(r => r.state === 'active' && r.executorNodeId === link.executorNodeId)
    ) {
      return { ok: false, reason: 'executor_already_linked' } as const
    }
    if (
      link.spawnRequestId &&
      rows.some(
        r =>
          r.orchestratorNodeId === link.orchestratorNodeId &&
          r.spawnRequestId === link.spawnRequestId,
      )
    ) {
      return { ok: false, reason: 'spawn_request_duplicate' } as const
    }
    this.links.rows.set(link.id, link)
    this.links.revision += 1
    return { ok: true } as const
  }

  private acceptStep(dispatch: Dispatch): { dispatch: Dispatch; link: AgentLink } {
    const refuse = (reason: AcceptRefusal): never => {
      throw new Refusal(reason)
    }
    const stored = this.links.rows.get(dispatch.linkId)
    if (!stored || stored.state !== 'active') {
      refuse('link_not_active')
    }
    if (stored!.roundsUsed >= stored!.roundsLimit) {
      refuse('round_limit_reached')
    }
    if (this.dispatches.rows.has(dispatch.id)) {
      refuse('id_exists')
    }
    const open = [...this.dispatches.rows.values()].some(
      d => d.executorNodeId === dispatch.executorNodeId && !isFinalDispatchState(d.state),
    )
    if (open) {
      refuse('executor_busy')
    }
    this.writeLink({ ...stored!, roundsUsed: stored!.roundsUsed + 1 }, dispatch.createdAt)
    this.failIf('accept')
    const next = { ...dispatch, round: stored!.roundsUsed + 1 }
    this.dispatches.rows.set(next.id, next)
    this.dispatches.insertCalls += 1
    return { dispatch: next, link: this.links.rows.get(next.linkId)! }
  }

  private writeLink(next: AgentLink, at: string): void {
    this.links.rows.set(next.id, { ...next, revision: next.revision + 1, updatedAt: at })
    this.links.revision += 1
  }

  private failIf(point: 'accept' | 'settle'): void {
    if (this.failAt === point) {
      this.failAt = null
      throw new Error(`injected failure at ${point}`)
    }
  }

  private atomically<T>(step: () => T) {
    const snapshot = {
      links: new Map(this.links.rows),
      revision: this.links.revision,
      dispatches: new Map(this.dispatches.rows),
      notices: [...this.notices.rows],
    }
    try {
      return step()
    } catch (error) {
      this.links.rows.clear()
      snapshot.links.forEach((value, key) => this.links.rows.set(key, value))
      this.links.revision = snapshot.revision
      this.dispatches.rows.clear()
      snapshot.dispatches.forEach((value, key) => this.dispatches.rows.set(key, value))
      this.notices.rows.splice(0, this.notices.rows.length, ...snapshot.notices)
      if (error instanceof Refusal) {
        return { ok: false, reason: error.reason } as never
      }
      throw error
    }
  }
}
