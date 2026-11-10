import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createExecutorLink,
  type AgentLink,
} from '../../../../../src/contexts/orchestration/domain/agentLink'
import {
  assertDispatchText,
  classifyDispatchRequest,
  createDispatch,
  DispatchRuleError,
  isDeadlineExceeded,
  isFinalDispatchState,
  transitionDispatch,
  type Dispatch,
  type DispatchEvent,
  type DispatchState,
} from '../../../../../src/contexts/orchestration/domain/dispatch'

const t0 = new Date('2026-11-09T12:00:00.000Z')
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const later = new Date('2026-11-09T12:01:00.000Z')

function activeLink(overrides: Partial<AgentLink> = {}): AgentLink {
  return {
    ...createExecutorLink({
      id: 'link-1',
      spaceId: 's1',
      orchestrator: { nodeId: 'orq', projectId: 'p1', provider: 'claude-code' },
      executor: { nodeId: 'exec', projectId: 'p1', provider: 'codex' },
      spawnRequestId: null,
      existingLinks: [],
      now: t0,
    }),
    ...overrides,
  }
}

function queued(text = 'faça isso'): Dispatch {
  return createDispatch({ id: 'd1', link: activeLink(), text, textSha256: sha256(text), now: t0 })
    .dispatch
}

const finished = {
  outcome: 'completed' as const,
  finalExcerpt: 'ok',
  finalChars: 2,
}

function reach(state: DispatchState): Dispatch {
  const base = queued()
  const reserved = transitionDispatch(base, { type: 'reserve', now: t0 }).dispatch
  switch (state) {
    case 'queued':
      return base
    case 'reserved':
      return reserved
    case 'sent':
      return transitionDispatch(reserved, { type: 'service_accepted', turnRef: 'tr', now: t0 })
        .dispatch
    case 'uncertain':
      return transitionDispatch(reserved, { type: 'send_uncertain', now: t0 }).dispatch
    case 'completed':
      return transitionDispatch(reach('sent'), { type: 'turn_finished', now: later, ...finished })
        .dispatch
    case 'failed':
      return transitionDispatch(reserved, { type: 'service_rejected', now: t0 }).dispatch
    case 'cancelled':
      return transitionDispatch(base, { type: 'cancel', now: t0 }).dispatch
  }
}

const ALL_STATES: readonly DispatchState[] = [
  'queued',
  'reserved',
  'sent',
  'uncertain',
  'completed',
  'failed',
  'cancelled',
]

const events: Record<string, DispatchEvent> = {
  reserve: { type: 'reserve', now: later },
  cancel: { type: 'cancel', now: later },
  service_accepted: { type: 'service_accepted', turnRef: 'tr', now: later },
  service_rejected: { type: 'service_rejected', now: later },
  send_uncertain: { type: 'send_uncertain', now: later },
  turn_found_running: { type: 'turn_found_running', turnRef: 'tr', now: later },
  turn_finished: { type: 'turn_finished', now: later, ...finished },
  turn_absent: { type: 'turn_absent', now: later },
  executor_down: { type: 'executor_down', now: later },
  executor_unavailable: { type: 'executor_unavailable', now: later },
}

interface Row {
  from: DispatchState
  event: keyof typeof events
  to: DispatchState
  reason: Dispatch['reason']
  refund: boolean
}

const TABLE: readonly Row[] = [
  { from: 'queued', event: 'reserve', to: 'reserved', reason: null, refund: false },
  { from: 'queued', event: 'cancel', to: 'cancelled', reason: null, refund: true },
  {
    from: 'queued',
    event: 'executor_unavailable',
    to: 'failed',
    reason: 'not_sent',
    refund: true,
  },
  { from: 'reserved', event: 'service_accepted', to: 'sent', reason: null, refund: false },
  { from: 'reserved', event: 'service_rejected', to: 'failed', reason: 'not_sent', refund: true },
  { from: 'reserved', event: 'send_uncertain', to: 'uncertain', reason: null, refund: false },
  { from: 'uncertain', event: 'turn_found_running', to: 'sent', reason: null, refund: false },
  { from: 'uncertain', event: 'turn_finished', to: 'completed', reason: null, refund: false },
  { from: 'uncertain', event: 'turn_absent', to: 'failed', reason: 'not_sent', refund: true },
  {
    from: 'uncertain',
    event: 'executor_down',
    to: 'failed',
    reason: 'executor_down',
    refund: false,
  },
  { from: 'sent', event: 'turn_finished', to: 'completed', reason: null, refund: false },
  { from: 'sent', event: 'executor_down', to: 'failed', reason: 'executor_down', refund: false },
]

describe('dispatch state machine (U-04)', () => {
  it('creates queued, consuming a round, with hash and size and a 30 min deadline', () => {
    const { dispatch, rounds } = createDispatch({
      id: 'd1',
      link: activeLink(),
      text: 'olá ✓',
      textSha256: sha256('olá ✓'),
      now: t0,
    })
    expect(dispatch).toMatchObject({
      state: 'queued',
      round: 1,
      text: 'olá ✓',
      textBytes: Buffer.byteLength('olá ✓', 'utf8'),
      textSha256: sha256('olá ✓'),
      deadlineAt: '2026-11-09T12:30:00.000Z',
      reservedAt: null,
    })
    expect(rounds).toEqual({ roundsUsed: 1, roundsLimit: 3 })
  })

  it('refuses text outside 1 to 32768 bytes', () => {
    const create = (text: string) => () =>
      createDispatch({ id: 'd', link: activeLink(), text, textSha256: sha256(text), now: t0 })
    expect(create('')).toThrowError(expect.any(DispatchRuleError))
    expect(create('a'.repeat(32_769))).toThrowError(expect.any(DispatchRuleError))
    expect(create('é'.repeat(16_385))).toThrowError(expect.any(DispatchRuleError))
    expect(create('a'.repeat(32_768))).not.toThrow()
  })

  it('refuses without an active link or without a round', () => {
    expect(() =>
      createDispatch({
        id: 'd',
        link: activeLink({ state: 'closed' }),
        text: 'x',
        textSha256: sha256('x'),
        now: t0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'orch.not_linked' }))
    expect(() =>
      createDispatch({
        id: 'd',
        link: activeLink({ roundsUsed: 3 }),
        text: 'x',
        textSha256: sha256('x'),
        now: t0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'orch.round_limit_reached' }))
  })

  it.each(TABLE)('$from + $event -> $to', row => {
    const result = transitionDispatch(reach(row.from), events[row.event])
    expect(result.dispatch.state).toBe(row.to)
    expect(result.dispatch.reason).toBe(row.reason)
    expect(result.returnsRound).toBe(row.refund)
    expect(result.dispatch.revision).toBe(reach(row.from).revision + 1)
  })

  it('every pair outside the table throws a domain error, and finals accept nothing (D4)', () => {
    const allowed = new Set(TABLE.map(row => `${row.from}:${row.event}`))
    for (const state of ALL_STATES) {
      for (const name of Object.keys(events)) {
        if (allowed.has(`${state}:${name}`)) {
          continue
        }
        expect(
          () => transitionDispatch(reach(state), events[name]),
          `${state}:${name}`,
        ).toThrowError(expect.objectContaining({ code: 'invalid_transition' }))
      }
    }
    expect(ALL_STATES.filter(isFinalDispatchState)).toEqual(['completed', 'failed', 'cancelled'])
  })

  it('failed outcomes map to turn_failed and interrupted', () => {
    const sent = reach('sent')
    const failed = transitionDispatch(sent, {
      type: 'turn_finished',
      now: later,
      outcome: 'failed',
      finalExcerpt: null,
      finalChars: null,
    }).dispatch
    const interrupted = transitionDispatch(sent, {
      type: 'turn_finished',
      now: later,
      outcome: 'interrupted',
      finalExcerpt: null,
      finalChars: null,
    }).dispatch
    expect([failed.state, failed.reason]).toEqual(['failed', 'turn_failed'])
    expect([interrupted.state, interrupted.reason]).toEqual(['failed', 'interrupted'])
  })

  it('D8: text is kept in queued and reserved and erased when leaving reserved', () => {
    expect(reach('queued').text).toBe('faça isso')
    expect(reach('reserved').text).toBe('faça isso')
    expect(reach('reserved').reservedAt).toBe(t0.toISOString())
    for (const state of ['sent', 'uncertain', 'failed', 'completed', 'cancelled'] as const) {
      const dispatch = reach(state)
      expect(dispatch.text, state).toBeNull()
      expect(dispatch.textSha256).toBe(sha256('faça isso'))
      expect(dispatch.textBytes).toBe(Buffer.byteLength('faça isso', 'utf8'))
    }
  })

  it('records turn, summary and finish time', () => {
    const sent = reach('sent')
    expect(sent).toMatchObject({ turnRef: 'tr', sentAt: t0.toISOString() })
    const done = transitionDispatch(sent, {
      type: 'turn_finished',
      now: later,
      glimpseTurnId: 'gt',
      ...finished,
    }).dispatch
    expect(done).toMatchObject({
      outcome: 'completed',
      finalExcerpt: 'ok',
      finalChars: 2,
      glimpseTurnId: 'gt',
      finishedAt: later.toISOString(),
    })
  })

  it('deadline passed changes no state and only flags sent dispatches', () => {
    const sent = reach('sent')
    const after = new Date('2026-11-09T12:31:00.000Z')
    expect(isDeadlineExceeded(sent, t0)).toBe(false)
    expect(isDeadlineExceeded(sent, after)).toBe(true)
    expect(isDeadlineExceeded(reach('completed'), after)).toBe(false)
    expect(sent.state).toBe('sent')
  })
})

describe('dispatch idempotency (D5)', () => {
  const identity = (overrides = {}) => ({
    id: 'd2',
    executorNodeId: 'exec',
    textSha256: sha256('faça isso'),
    ...overrides,
  })

  it('D5: same id and payload returns the existing one', () => {
    const existing = queued()
    expect(classifyDispatchRequest(identity({ id: 'd1' }), [existing])).toEqual({
      kind: 'duplicate',
      dispatch: existing,
    })
  })

  it('D5: same id with another payload is a conflict', () => {
    expect(() =>
      classifyDispatchRequest(identity({ id: 'd1', textSha256: sha256('outro') }), [queued()]),
    ).toThrowError(expect.objectContaining({ code: 'orch.dispatch_conflict' }))
  })

  it('D6: same content with another id is new, whatever the state or the age', () => {
    expect(classifyDispatchRequest(identity(), [queued()]).kind).toBe('new')
    expect(classifyDispatchRequest(identity(), [reach('completed')]).kind).toBe('new')
  })
})

describe('assertDispatchText', () => {
  it('accepts 1 to 32768 bytes counted in utf-8', () => {
    expect(() => assertDispatchText('a')).not.toThrow()
    expect(() => assertDispatchText('a'.repeat(32_768))).not.toThrow()
    expect(() => assertDispatchText('é'.repeat(16_384))).not.toThrow()
  })

  it.each([
    ['empty', ''],
    ['over the limit', 'a'.repeat(32_769)],
    ['multibyte over', 'é'.repeat(16_385)],
  ])('refuses %s text as invalid_text', (_name, text) => {
    expect(() => assertDispatchText(text)).toThrow(DispatchRuleError)
    expect(() => assertDispatchText(text)).toThrowError(/1 to 32768 bytes/)
  })
})
