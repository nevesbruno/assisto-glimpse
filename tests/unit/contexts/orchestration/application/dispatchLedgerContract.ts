import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentLinkRepository,
  DispatchLedger,
  DispatchRepository,
  NoticeOutboxRepository,
  StoredNotice,
} from '../../../../../src/contexts/orchestration/application/ports'
import {
  createExecutorLink,
  ORCHESTRATOR_PROVIDER,
  type AgentLink,
} from '../../../../../src/contexts/orchestration/domain/agentLink'
import {
  createDispatch,
  transitionDispatch,
  type Dispatch,
  type DispatchEvent,
} from '../../../../../src/contexts/orchestration/domain/dispatch'

/** `accept`: after the round is consumed, before the dispatch row. `settle`: before the notice. */
export type LedgerFailurePoint = 'accept' | 'settle'

export interface LedgerFixture {
  readonly ledger: DispatchLedger
  readonly links: Pick<
    AgentLinkRepository,
    'insert' | 'findById' | 'readLinksRevision' | 'extendRounds'
  >
  readonly dispatches: Pick<DispatchRepository, 'findById' | 'findNonFinalByExecutor'>
  readonly notices: Pick<NoticeOutboxRepository, 'listPending'>
  /** The next ledger operation fails once the named step is reached. */
  readonly injectFailure: (point: LedgerFailurePoint) => void
  readonly dispose?: () => void
}

const NOW = new Date('2026-11-09T12:00:00.000Z')
const LATER = new Date('2026-11-09T12:05:00.000Z')

function makeLink(id: string, executor = 'exec-a', overrides: Partial<AgentLink> = {}): AgentLink {
  return {
    ...createExecutorLink({
      id,
      spaceId: 'space-1',
      orchestrator: { nodeId: 'orch-1', projectId: 'project-1', provider: ORCHESTRATOR_PROVIDER },
      executor: { nodeId: executor, projectId: 'project-1', provider: 'codex' },
      spawnRequestId: null,
      existingLinks: [],
      now: NOW,
    }),
    ...overrides,
  }
}

function makeDispatch(id: string, link: AgentLink): Dispatch {
  return createDispatch({
    id,
    link: { ...link, state: 'active', roundsUsed: 0, roundsLimit: 99 },
    text: `work ${id}`,
    textSha256: `sha-${id}`,
    now: NOW,
  }).dispatch
}

function makeNotice(dispatch: Dispatch, id = `n-${dispatch.id}`): StoredNotice {
  return {
    id,
    orchestratorNodeId: dispatch.orchestratorNodeId,
    dedupeKey: `${dispatch.id}:${dispatch.state}`,
    state: 'pending',
    batchId: null,
    createdAt: LATER.toISOString(),
    settledAt: null,
    entry: {
      executorNodeId: dispatch.executorNodeId,
      executorName: 'exec',
      provider: 'codex',
      kind: 'completed',
      round: dispatch.round,
      roundsLimit: 3,
      dispatchId: dispatch.id,
      glimpseTurnId: null,
      excerpt: null,
      createdAt: LATER.toISOString(),
    },
  }
}

const reserve: DispatchEvent = { type: 'reserve', now: LATER }
const accepted: DispatchEvent = { type: 'service_accepted', turnRef: 't1', now: LATER }
const finished: DispatchEvent = {
  type: 'turn_finished',
  outcome: 'completed',
  finalExcerpt: null,
  finalChars: null,
  now: LATER,
}
const cancel: DispatchEvent = { type: 'cancel', now: LATER }

export function describeDispatchLedgerContract(name: string, create: () => LedgerFixture): void {
  describe(`DispatchLedger contract, ${name}`, () => {
    let fx: LedgerFixture
    beforeEach(() => {
      fx = create()
    })
    afterEach(() => fx.dispose?.())

    async function seed(overrides: Partial<AgentLink> = {}) {
      const link = makeLink('l1', 'exec-a', overrides)
      expect((await fx.links.insert(link)).ok).toBe(true)
      return link
    }

    async function acceptFirst(link: AgentLink, id = 'd1') {
      const result = await fx.ledger.acceptDispatch(makeDispatch(id, link))
      if (!result.ok) {
        throw new Error(`accept refused: ${result.reason}`)
      }
      return result
    }

    async function settle(dispatch: Dispatch, event: DispatchEvent, refundRound = false) {
      const next = transitionDispatch(dispatch, event).dispatch
      const result = await fx.ledger.settleDispatch({
        next,
        refundRound,
        notice: null,
        at: LATER.toISOString(),
      })
      if (!result.ok) {
        throw new Error(`settle refused: ${result.reason}`)
      }
      return result.dispatch
    }

    describe('acceptDispatch', () => {
      it('consumes the round in the store and takes the round number from it', async () => {
        const link = await seed()
        const before = await fx.links.readLinksRevision()
        const result = await fx.ledger.acceptDispatch({ ...makeDispatch('d1', link), round: 77 })
        expect(result).toMatchObject({
          ok: true,
          dispatch: { id: 'd1', round: 1, state: 'queued' },
          link: { roundsUsed: 1, roundsLimit: 3, revision: link.revision + 1 },
        })
        expect(await fx.links.findById('l1')).toMatchObject({ roundsUsed: 1 })
        expect(await fx.dispatches.findById('d1')).toMatchObject({ round: 1 })
        expect(await fx.links.readLinksRevision()).toBe(before + 1)
      })

      it('keeps a limit extended after the caller read the link (T1 at the store)', async () => {
        const link = await seed()
        await fx.links.extendRounds('l1', 2, LATER.toISOString())
        const result = await fx.ledger.acceptDispatch(makeDispatch('d1', link))
        expect(result).toMatchObject({ ok: true, link: { roundsUsed: 1, roundsLimit: 5 } })
        expect(await fx.links.findById('l1')).toMatchObject({ roundsUsed: 1, roundsLimit: 5 })
      })

      it.each([
        ['link_not_active', { state: 'closed' as const }],
        ['round_limit_reached', { roundsUsed: 3, roundsLimit: 3 }],
      ])('refuses with %s and writes nothing', async (reason, overrides) => {
        const link = await seed(overrides)
        expect(await fx.ledger.acceptDispatch(makeDispatch('d1', link))).toEqual({
          ok: false,
          reason,
        })
        expect(await fx.dispatches.findById('d1')).toBeNull()
        expect((await fx.links.findById('l1'))?.roundsUsed).toBe(overrides.roundsUsed ?? 0)
      })

      it('refuses id_exists and executor_busy without consuming a round', async () => {
        const link = await seed()
        await acceptFirst(link)
        expect(await fx.ledger.acceptDispatch(makeDispatch('d1', link))).toEqual({
          ok: false,
          reason: 'id_exists',
        })
        expect(await fx.ledger.acceptDispatch(makeDispatch('d2', link))).toEqual({
          ok: false,
          reason: 'executor_busy',
        })
        expect((await fx.links.findById('l1'))?.roundsUsed).toBe(1)
      })

      it('T13: a failure after consuming the round leaves no dispatch and no round used', async () => {
        const link = await seed()
        fx.injectFailure('accept')
        await expect(fx.ledger.acceptDispatch(makeDispatch('d1', link))).rejects.toThrow()
        expect(await fx.dispatches.findById('d1')).toBeNull()
        expect(await fx.links.findById('l1')).toEqual(link)
      })
    })

    describe('createLinkWithDispatch', () => {
      it('stores the link and its first dispatch together', async () => {
        const link = makeLink('l1')
        const result = await fx.ledger.createLinkWithDispatch(link, makeDispatch('d1', link))
        expect(result).toMatchObject({
          ok: true,
          link: { id: 'l1', roundsUsed: 1 },
          dispatch: { id: 'd1', round: 1 },
        })
        expect(await fx.dispatches.findById('d1')).toMatchObject({ state: 'queued' })
      })

      it('stores only the link when there is no dispatch', async () => {
        const link = makeLink('l1')
        expect(await fx.ledger.createLinkWithDispatch(link, null)).toMatchObject({
          ok: true,
          dispatch: null,
        })
        expect(await fx.links.findById('l1')).toEqual(link)
      })

      it('a refused dispatch leaves no link behind', async () => {
        const link = makeLink('l1')
        await fx.ledger.createLinkWithDispatch(link, makeDispatch('d1', link))
        const other = makeLink('l2', 'exec-b')
        expect(await fx.ledger.createLinkWithDispatch(other, makeDispatch('d1', other))).toEqual({
          ok: false,
          reason: 'id_exists',
        })
        expect(await fx.links.findById('l2')).toBeNull()
      })

      it('a refused link leaves no dispatch behind', async () => {
        await seed()
        const twin = makeLink('l2', 'exec-a')
        expect(await fx.ledger.createLinkWithDispatch(twin, makeDispatch('d2', twin))).toEqual({
          ok: false,
          reason: 'executor_already_linked',
        })
        expect(await fx.dispatches.findById('d2')).toBeNull()
      })
    })

    describe('settleDispatch', () => {
      it('T14: stores the final dispatch, returns the round and queues the notice in one step', async () => {
        const link = await seed()
        const { dispatch } = await acceptFirst(link)
        const next = transitionDispatch(dispatch, cancel).dispatch
        const result = await fx.ledger.settleDispatch({
          next,
          refundRound: true,
          notice: makeNotice(next),
          at: LATER.toISOString(),
        })
        expect(result).toMatchObject({
          ok: true,
          dispatch: { state: 'cancelled' },
          link: { roundsUsed: 0 },
          noticeEnqueued: true,
        })
        expect(await fx.links.findById('l1')).toMatchObject({ roundsUsed: 0 })
        expect(await fx.notices.listPending('orch-1')).toHaveLength(1)
      })

      it('T14: a failure before the notice undoes the dispatch and the refund', async () => {
        const link = await seed()
        const { dispatch } = await acceptFirst(link)
        const next = transitionDispatch(dispatch, cancel).dispatch
        fx.injectFailure('settle')
        await expect(
          fx.ledger.settleDispatch({
            next,
            refundRound: true,
            notice: makeNotice(next),
            at: LATER.toISOString(),
          }),
        ).rejects.toThrow()
        expect(await fx.dispatches.findById('d1')).toEqual(dispatch)
        expect((await fx.links.findById('l1'))?.roundsUsed).toBe(1)
        expect(await fx.notices.listPending('orch-1')).toHaveLength(0)
      })

      it('returns the round without a notice when none is given', async () => {
        const link = await seed()
        const { dispatch } = await acceptFirst(link)
        await settle(dispatch, cancel, true)
        expect((await fx.links.findById('l1'))?.roundsUsed).toBe(0)
        expect(await fx.notices.listPending('orch-1')).toHaveLength(0)
      })

      it('deduplicates the notice by key', async () => {
        const link = await seed()
        const { dispatch } = await acceptFirst(link)
        const next = transitionDispatch(dispatch, cancel).dispatch
        const input = {
          next,
          refundRound: false,
          notice: makeNotice(next),
          at: LATER.toISOString(),
        }
        await fx.ledger.settleDispatch(input)
        const stale = { ...input, next: { ...next, revision: next.revision + 1 } }
        const second = await fx.ledger.settleDispatch({
          ...stale,
          notice: makeNotice(next, 'n-other'),
        })
        expect(second).toMatchObject({ ok: true, noticeEnqueued: false })
        expect(await fx.notices.listPending('orch-1')).toHaveLength(1)
      })

      it('answers revision_conflict and not_found without writing', async () => {
        const link = await seed()
        const { dispatch } = await acceptFirst(link)
        await settle(dispatch, reserve)
        const stale = transitionDispatch(dispatch, cancel).dispatch
        expect(
          await fx.ledger.settleDispatch({
            next: stale,
            refundRound: true,
            notice: null,
            at: LATER.toISOString(),
          }),
        ).toEqual({ ok: false, reason: 'revision_conflict' })
        expect((await fx.links.findById('l1'))?.roundsUsed).toBe(1)
        expect(
          await fx.ledger.settleDispatch({
            next: { ...stale, id: 'ghost' },
            refundRound: false,
            notice: null,
            at: LATER.toISOString(),
          }),
        ).toEqual({ ok: false, reason: 'not_found' })
      })

      it('T18: refuses to reserve while another dispatch of the executor is in flight', async () => {
        const link = await seed()
        const { dispatch } = await acceptFirst(link)
        await settle(dispatch, reserve)
        const intruder = transitionDispatch(makeDispatch('d2', link), reserve).dispatch
        expect(
          await fx.ledger.settleDispatch({
            next: intruder,
            refundRound: false,
            notice: null,
            at: LATER.toISOString(),
          }),
        ).toEqual({ ok: false, reason: 'in_flight_conflict' })
      })

      it('walks queued to completed and frees the executor', async () => {
        const link = await seed()
        const { dispatch } = await acceptFirst(link)
        const reserved = await settle(dispatch, reserve)
        const sent = await settle(reserved, accepted)
        const done = await settle(sent, finished)
        expect(done.state).toBe('completed')
        expect(await fx.dispatches.findNonFinalByExecutor('exec-a')).toBeNull()
      })
    })
  })
}
