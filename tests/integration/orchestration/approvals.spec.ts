// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { registerOrchestrationHandlers } from '../../../src/app/main/controlSurface/handlers/orchestrationHandlers'
import type { ExecutorRuntimeEvent } from '../../../src/contexts/orchestration/application/ports/executorRuntime'
import { ORCHESTRATOR_PROVIDER } from '../../../src/contexts/orchestration/domain/agentLink'
import type { CodexWorker } from './codexServiceRig'
import { startLinkedCodexWorker } from './codexServiceRig'
import {
  AS_ORCHESTRATOR,
  EXECUTOR_NODE,
  ORCHESTRATOR_NODE,
  createRig,
  settle,
  type Rig,
} from './phase2Rig'

const APPROVAL = 'item/commandExecution/requestApproval'
const SESSION_REF = 'thr-1'

const user: ControlSurfaceContext = { now: () => new Date(), capabilities: {} } as never

const grantOfOrchestrator: ControlSurfaceContext = {
  now: () => new Date(),
  capabilities: {},
  requestAuth: {
    kind: 'session-grant',
    grant: {
      projectId: 'project-1',
      spaceId: 'space-1',
      nodeId: ORCHESTRATOR_NODE,
      sessionId: 'session-orch-1',
    },
  },
  assertActive: () => undefined,
} as never

function requestApproval(env: CodexWorker['env'], requestId: string): Promise<unknown> {
  const held = env
    .client()
    .serverRequest(APPROVAL, { command: ['echo', 'hi'], turnId: 'turn-1' }, requestId)
  if (!held) {
    throw new Error(`no handler for ${APPROVAL}`)
  }
  return held
}

function handlersOf(worker: CodexWorker['worker']) {
  const registered = new Map<
    string,
    {
      handle: (ctx: ControlSurfaceContext, input: unknown) => Promise<unknown>
      validate: (payload: unknown) => unknown
    }
  >()
  registerOrchestrationHandlers(
    { register: (id: string, handler: never) => registered.set(id, handler) } as never,
    {
      backend: () => ({ service: worker.composed.service, links: worker.composed.links }),
      providerOfNode: async nodeId =>
        nodeId === ORCHESTRATOR_NODE ? ORCHESTRATOR_PROVIDER : 'codex',
    },
  )
  return (id: string, payload: unknown, ctx: ControlSurfaceContext): Promise<unknown> => {
    const handler = registered.get(id)!
    return handler.handle(ctx, handler.validate(payload))
  }
}

const pendingCount = async (worker: CodexWorker['worker']): Promise<number> => {
  const status = await worker.composed.service.status(AS_ORCHESTRATOR, {})
  return status.links[0].pendingApprovals
}

const noticeKinds = (rig: Rig): string[] => rig.notices().map(notice => notice.kind)

let rig: Rig
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'))
  rig = createRig()
})
afterEach(() => {
  vi.useRealTimers()
  rig.dispose()
})

describe('I-06 approvals (real runtime and supervisor over a fake process)', () => {
  it('holds a requested approval with no automatic answer and shows it as pending', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    const events: ExecutorRuntimeEvent[] = []
    worker.composed.service.subscribeEvents((_nodeId, event) => events.push(event))

    let answered: unknown = null
    void requestApproval(env, 'req-hold').then(value => {
      answered = value
    })
    await settle()

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval.requested',
        requestId: 'req-hold',
        turnRef: 'turn-1',
        kind: 'command',
      }),
    )
    expect(await pendingCount(worker)).toBe(1)
    await settle(119_000)
    expect(answered).toBeNull()
    expect(await pendingCount(worker)).toBe(1)
  })

  it('orch.approval.respond from the user answers the service and clears the pending count', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    const events: ExecutorRuntimeEvent[] = []
    worker.composed.service.subscribeEvents((_nodeId, event) => events.push(event))
    const call = handlersOf(worker)

    const held = requestApproval(env, 'req-respond')
    await settle()
    expect(await pendingCount(worker)).toBe(1)

    await expect(
      call(
        'orch.approval.respond',
        {
          executorNodeId: EXECUTOR_NODE,
          requestId: 'req-respond',
          decision: 'acceptForSession',
        },
        user,
      ),
    ).resolves.toEqual({ ok: true })

    await expect(held).resolves.toEqual({ decision: 'acceptForSession' })
    await settle()
    expect(await pendingCount(worker)).toBe(0)
    expect(events).toContainEqual({
      type: 'approval.resolved',
      requestId: 'req-respond',
      resolvedBy: 'glimpse',
    })
  })

  it('an answer given on the executor screen clears the pending approval', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    const events: ExecutorRuntimeEvent[] = []
    worker.composed.service.subscribeEvents((_nodeId, event) => events.push(event))

    const held = requestApproval(env, 'req-screen')
    await settle()
    expect(await pendingCount(worker)).toBe(1)

    env
      .client()
      .notify('serverRequest/resolved', { threadId: SESSION_REF, requestId: 'req-screen' })
    await settle()

    await expect(held).resolves.toEqual({ decision: 'cancel' })
    expect(await pendingCount(worker)).toBe(0)
    expect(events).toContainEqual({
      type: 'approval.resolved',
      requestId: 'req-screen',
      resolvedBy: 'screen',
    })
  })

  it('the grant of an orchestrator receives orch.forbidden and the request stays pending', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    const call = handlersOf(worker)
    const held = requestApproval(env, 'req-grant')
    await settle()

    await expect(
      call(
        'orch.approval.respond',
        {
          executorNodeId: EXECUTOR_NODE,
          requestId: 'req-grant',
          decision: 'decline',
        },
        grantOfOrchestrator,
      ),
    ).rejects.toMatchObject({ code: 'orch.forbidden' })

    expect(await pendingCount(worker)).toBe(1)
    let answered = false
    void held.then(() => {
      answered = true
    })
    await settle()
    expect(answered).toBe(false)
  })

  it('settle(120000) queues exactly one approval_unanswered and never repeats it', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    void requestApproval(env, 'req-timeout')
    await settle()

    await settle(119_000)
    expect(noticeKinds(rig).filter(kind => kind === 'approval_unanswered')).toEqual([])
    await settle(1000)

    const unanswered = rig.notices().filter(notice => notice.kind === 'approval_unanswered')
    expect(unanswered).toHaveLength(1)
    expect(unanswered[0].dedupeKey).toBe('approval:exec-1:req-timeout')
    expect(await pendingCount(worker)).toBe(1)

    await settle(120_000)
    expect(noticeKinds(rig).filter(kind => kind === 'approval_unanswered')).toHaveLength(1)
  })

  it('an unknown server request is answered with -32601 and degrades the executor', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)

    expect(env.client().serverRequest('weird/method', {}, 'unhandled-1')).toBeNull()
    await settle()

    expect(env.events).toContainEqual({
      type: 'executor.degraded',
      reason: 'unsupported_request:weird/method',
    })
    expect(worker.composed.service.healthOf(EXECUTOR_NODE)).toBe('degraded')
  })
})
