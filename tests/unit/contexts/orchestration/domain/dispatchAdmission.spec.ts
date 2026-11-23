import { describe, expect, it } from 'vitest'
import {
  createExecutorLink,
  type AgentLink,
} from '../../../../../src/contexts/orchestration/domain/agentLink'
import {
  createDispatch,
  transitionDispatch,
  type DispatchState,
} from '../../../../../src/contexts/orchestration/domain/dispatch'
import {
  evaluateDispatchAdmission,
  type AdmissionInput,
  type ExecutorHealth,
} from '../../../../../src/contexts/orchestration/domain/dispatchAdmission'

const now = new Date('2026-11-09T12:00:00.000Z')

function activeLink(overrides: Partial<AgentLink> = {}): AgentLink {
  return {
    ...createExecutorLink({
      id: 'link-1',
      spaceId: 's1',
      orchestrator: { nodeId: 'orq', projectId: 'p1', provider: 'claude-code' },
      executor: { nodeId: 'exec', projectId: 'p1', provider: 'codex' },
      spawnRequestId: null,
      existingLinks: [],
      now,
    }),
    ...overrides,
  }
}

function open(state: Extract<DispatchState, 'queued' | 'reserved' | 'sent' | 'uncertain'>) {
  const queued = createDispatch({
    id: 'd-open',
    link: activeLink(),
    text: 'x',
    textSha256: 'h',
    now,
  }).dispatch
  const reserved = transitionDispatch(queued, { type: 'reserve', now }).dispatch
  switch (state) {
    case 'queued':
      return queued
    case 'reserved':
      return reserved
    case 'sent':
      return transitionDispatch(reserved, { type: 'service_accepted', turnRef: 't', now }).dispatch
    case 'uncertain':
      return transitionDispatch(reserved, { type: 'send_uncertain', now }).dispatch
  }
}

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return { link: activeLink(), health: 'ready', openDispatch: null, ...overrides }
}

const accepted = { canDispatch: true, reason: null, blocking: null }

describe('dispatch admission (U-12)', () => {
  it('refuses a closed link and a missing link with orch.not_linked', () => {
    const closed = activeLink({ state: 'closed' })
    expect(() => evaluateDispatchAdmission(input({ link: closed }))).toThrowError(
      expect.objectContaining({ code: 'orch.not_linked' }),
    )
    expect(() => evaluateDispatchAdmission(input({ link: null }))).toThrowError(
      expect.objectContaining({ code: 'orch.not_linked' }),
    )
  })

  it('refuses when the rounds are spent', () => {
    expect(evaluateDispatchAdmission(input({ link: activeLink({ roundsUsed: 3 }) }))).toEqual({
      canDispatch: false,
      reason: 'round_limit_reached',
      blocking: null,
      willWait: false,
    })
  })

  it('refuses when the executor is unavailable', () => {
    expect(evaluateDispatchAdmission(input({ health: 'unavailable' }))).toEqual({
      canDispatch: false,
      reason: 'executor_unavailable',
      blocking: null,
      willWait: false,
    })
  })

  it.each(['queued', 'reserved', 'sent', 'uncertain'] as const)(
    'refuses with dispatch_in_flight naming the %s blocker',
    state => {
      const openDispatch = open(state)
      expect(evaluateDispatchAdmission(input({ openDispatch }))).toEqual({
        canDispatch: false,
        reason: 'dispatch_in_flight',
        blocking: { dispatchId: 'd-open', state, round: 1 },
        willWait: false,
      })
    },
  )

  it.each(['starting', 'degraded', 'busy'] as const)(
    'accepts and waits when health is %s',
    health => {
      expect(evaluateDispatchAdmission(input({ health }))).toEqual({ ...accepted, willWait: true })
    },
  )

  it('accepts without waiting when ready and nothing is open', () => {
    expect(evaluateDispatchAdmission(input())).toEqual({ ...accepted, willWait: false })
  })

  it('applies the first matching row, top to bottom', () => {
    const spent = activeLink({ roundsUsed: 3 })
    const openDispatch = open('sent')
    expect(
      evaluateDispatchAdmission(input({ link: spent, health: 'unavailable', openDispatch })).reason,
    ).toBe('round_limit_reached')
    expect(evaluateDispatchAdmission(input({ health: 'unavailable', openDispatch })).reason).toBe(
      'executor_unavailable',
    )
    expect(evaluateDispatchAdmission(input({ health: 'busy', openDispatch })).reason).toBe(
      'dispatch_in_flight',
    )
    expect(() =>
      evaluateDispatchAdmission(input({ link: null, health: 'unavailable', openDispatch })),
    ).toThrowError(expect.objectContaining({ code: 'orch.not_linked' }))
  })

  it('keeps the refinements: blocking only with dispatch_in_flight, willWait only when accepted', () => {
    const healths: ExecutorHealth[] = ['starting', 'ready', 'busy', 'degraded', 'unavailable']
    const links = [activeLink(), activeLink({ roundsUsed: 3 })]
    const dispatches = [null, open('queued'), open('uncertain')]
    for (const health of healths) {
      for (const link of links) {
        for (const openDispatch of dispatches) {
          const result = evaluateDispatchAdmission({ link, health, openDispatch })
          expect(result.blocking !== null).toBe(result.reason === 'dispatch_in_flight')
          expect(result.canDispatch).toBe(result.reason === null)
          if (!result.canDispatch) {
            expect(result.willWait).toBe(false)
          }
        }
      }
    }
  })

  it('takes neither a clock nor text in its input', () => {
    expect(Object.keys(input()).sort()).toEqual(['health', 'link', 'openDispatch'])
  })
})
