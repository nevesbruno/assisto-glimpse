import { describe, expect, it } from 'vitest'
import {
  orchestrationAdmissionSchema,
  orchestrationBlockingDispatchSchema,
  orchestrationDispatchAcceptedSchema,
  orchestrationDispatchFailureReasonSchema,
  orchestrationDispatchOutcomeSchema,
  orchestrationDispatchResultSchema,
  orchestrationDispatchViewSchema,
  orchestrationSpawnResultSchema,
  orchestrationStatusResultSchema,
  orchestrationAdmissionReasonSchema,
} from '../../../src/shared/contracts/dto'

const id = '7f3a2c1e-5b4d-4e6f-8a9b-0c1d2e3f4a5b'
const iso = '2026-11-09T12:00:00.000Z'

const blocking = { dispatchId: id, state: 'queued', round: 1 }
const blocked = {
  canDispatch: false,
  reason: 'dispatch_in_flight',
  blocking,
  willWait: false,
}
const open = { canDispatch: true, reason: null, blocking: null, willWait: false }
const accepted = { dispatchId: id, state: 'queued', round: 1, roundsLimit: 3 }
const view = {
  dispatchId: id,
  state: 'sent',
  round: 1,
  reason: null,
  outcome: null,
  createdAt: iso,
  deadlineAt: iso,
  finishedAt: null,
}
const linkEntry = {
  linkId: id,
  executorNodeId: 'node-1',
  title: 'Executor',
  provider: 'codex',
  runtimeMode: 'service',
  health: 'ready',
  roundsUsed: 0,
  roundsLimit: 3,
  admission: open,
  current: null,
  last: null,
  pendingApprovals: 0,
  pendingHooks: 0,
  notices: { pending: 0, uncertain: 0 },
}

describe('orch results contract', () => {
  it('fixes the enums', () => {
    expect(orchestrationDispatchFailureReasonSchema.options).toEqual([
      'not_sent',
      'executor_down',
      'turn_failed',
      'interrupted',
    ])
    expect(orchestrationDispatchOutcomeSchema.options).toEqual([
      'completed',
      'failed',
      'interrupted',
    ])
    expect(orchestrationAdmissionReasonSchema.options).toEqual([
      'round_limit_reached',
      'executor_unavailable',
      'dispatch_in_flight',
    ])
  })

  it('blockingDispatch accepts only open states and rounds from 1', () => {
    expect(orchestrationBlockingDispatchSchema.safeParse(blocking).success).toBe(true)
    expect(
      orchestrationBlockingDispatchSchema.safeParse({ ...blocking, state: 'completed' }).success,
    ).toBe(false)
    expect(orchestrationBlockingDispatchSchema.safeParse({ ...blocking, round: 0 }).success).toBe(
      false,
    )
    expect(orchestrationBlockingDispatchSchema.safeParse({ ...blocking, x: 1 }).success).toBe(false)
  })

  describe('admission', () => {
    it('accepts the coherent shapes', () => {
      expect(orchestrationAdmissionSchema.safeParse(open).success).toBe(true)
      expect(orchestrationAdmissionSchema.safeParse({ ...open, willWait: true }).success).toBe(true)
      expect(orchestrationAdmissionSchema.safeParse(blocked).success).toBe(true)
      expect(
        orchestrationAdmissionSchema.safeParse({
          ...blocked,
          reason: 'round_limit_reached',
          blocking: null,
        }).success,
      ).toBe(true)
    })

    it('refuses blocking outside dispatch_in_flight', () => {
      expect(
        orchestrationAdmissionSchema.safeParse({ ...blocked, reason: 'executor_unavailable' })
          .success,
      ).toBe(false)
      expect(orchestrationAdmissionSchema.safeParse({ ...open, blocking }).success).toBe(false)
    })

    it('refuses dispatch_in_flight without blocking', () => {
      expect(orchestrationAdmissionSchema.safeParse({ ...blocked, blocking: null }).success).toBe(
        false,
      )
    })

    it('refuses willWait without canDispatch', () => {
      expect(orchestrationAdmissionSchema.safeParse({ ...blocked, willWait: true }).success).toBe(
        false,
      )
    })

    it('refuses canDispatch false without reason and canDispatch true with reason', () => {
      expect(orchestrationAdmissionSchema.safeParse({ ...open, canDispatch: false }).success).toBe(
        false,
      )
      expect(
        orchestrationAdmissionSchema.safeParse({ ...open, reason: 'round_limit_reached' }).success,
      ).toBe(false)
    })
  })

  describe('dispatchView', () => {
    it('accepts reason only with state failed', () => {
      expect(orchestrationDispatchViewSchema.safeParse(view).success).toBe(true)
      expect(
        orchestrationDispatchViewSchema.safeParse({
          ...view,
          state: 'failed',
          reason: 'turn_failed',
          outcome: 'failed',
          finishedAt: iso,
        }).success,
      ).toBe(true)
    })

    it('refuses reason outside failed and failed without reason', () => {
      expect(
        orchestrationDispatchViewSchema.safeParse({ ...view, reason: 'not_sent' }).success,
      ).toBe(false)
      expect(orchestrationDispatchViewSchema.safeParse({ ...view, state: 'failed' }).success).toBe(
        false,
      )
    })
  })

  describe('results', () => {
    const dispatchResult = { ...accepted, duplicate: false, admission: blocked }

    it('orch.dispatch result', () => {
      expect(orchestrationDispatchAcceptedSchema.safeParse(accepted).success).toBe(true)
      expect(orchestrationDispatchResultSchema.safeParse(dispatchResult).success).toBe(true)
      const { round: _round, ...noRound } = dispatchResult
      expect(orchestrationDispatchResultSchema.safeParse(noRound).success).toBe(false)
    })

    it('orch.spawn result with and without prompt', () => {
      const spawn = {
        executorNodeId: 'node-1',
        linkId: id,
        runtimeMode: 'service',
        duplicate: false,
        dispatch: accepted,
        admission: blocked,
      }
      expect(orchestrationSpawnResultSchema.safeParse(spawn).success).toBe(true)
      expect(
        orchestrationSpawnResultSchema.safeParse({ ...spawn, dispatch: null, admission: open })
          .success,
      ).toBe(true)
      expect(
        orchestrationSpawnResultSchema.safeParse({ ...spawn, executorNodeId: '' }).success,
      ).toBe(false)
    })

    it('orch.status result', () => {
      const status = { linksRevision: 0, links: [linkEntry] }
      expect(orchestrationStatusResultSchema.safeParse(status).success).toBe(true)
      expect(
        orchestrationStatusResultSchema.safeParse({
          linksRevision: 2,
          links: [{ ...linkEntry, admission: blocked, current: view, last: null }],
        }).success,
      ).toBe(true)
      expect(
        orchestrationStatusResultSchema.safeParse({
          links: [{ ...linkEntry, roundsLimit: 0 }],
          linksRevision: 0,
        }).success,
      ).toBe(false)
      expect(
        orchestrationStatusResultSchema.safeParse({
          linksRevision: 0,
          links: [{ ...linkEntry, extra: 1 }],
        }).success,
      ).toBe(false)
    })
  })
})
