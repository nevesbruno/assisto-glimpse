// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerOrchestrationHandlers } from '../../../src/app/main/controlSurface/handlers/orchestrationHandlers'
import type { ControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { orchOperations } from '../../../src/shared/contracts/controlSurface/operations/domains/orch'
import {
  OrchestrationError,
  type AgentLink,
} from '../../../src/contexts/orchestration/domain/agentLink'
import { DispatchRuleError } from '../../../src/contexts/orchestration/domain/dispatch'
import { DispatchRefusedError } from '../../../src/contexts/orchestration/application/linkLifecycle'
import type { OpenCoveAppError } from '../../../src/shared/errors/appError'
import { orchestrationHooksApproveResultSchema } from '../../../src/shared/contracts/dto/orchestration'

const uuid = '91c2aaaa-0000-4000-8000-000000000001'
const LINK_ID = '7f3a0000-0000-4000-8000-000000000002'
const DISPATCH_ID = '5b1c0000-0000-4000-8000-000000000003'

const link: AgentLink = {
  id: LINK_ID,
  projectId: 'p1',
  spaceId: 's1',
  orchestratorNodeId: 'orq',
  executorNodeId: 'exec',
  kind: 'executor',
  origin: 'orchestrator_spawn',
  runtimeMode: 'service',
  provider: 'codex',
  state: 'active',
  closeReason: null,
  requestReason: null,
  requestedAt: null,
  messagesLimit: 5,
  messagesUsedSource: 0,
  messagesUsedTarget: 0,
  spawnRequestId: null,
  executorSessionRef: null,
  servicePid: null,
  serviceTokenSha256: null,
  roundsUsed: 1,
  roundsLimit: 3,
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  closedAt: null,
  revision: 2,
}

function harness() {
  const service = {
    spawn: vi.fn(async () => ({ spawned: true })),
    dispatch: vi.fn(async () => ({ dispatched: true })),
    status: vi.fn(async () => ({ linksRevision: 1, links: [] })),
    cancel: vi.fn(async () => ({ dispatchId: DISPATCH_ID, state: 'cancelled' })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    extendRounds: vi.fn(async () => ({ ...link, roundsLimit: 4 })),
    respondApproval: vi.fn(async () => undefined),
    approveHooks: vi.fn(async () => ({ approved: 2, restart: 'scheduled' as const })),
    createLink: vi.fn(async () => ({ linkId: LINK_ID, runtimeMode: 'service' as const })),
    healthOf: vi.fn(() => 'ready' as const),
    assertDirectInput: vi.fn(async () => undefined),
  }
  const links = {
    findById: vi.fn(async (id: string) => (id === LINK_ID ? link : null)),
    listActive: vi.fn(async () => [link]),
    listByProject: vi.fn(async () => [link]),
    readLinksRevision: vi.fn(async () => 9),
  }
  const available = { value: true }
  const providerOfNode = vi.fn(async () => 'claude-code' as string | null)
  const registered = new Map<
    string,
    {
      kind: string
      validate: (payload: unknown) => unknown
      handle: (ctx: ControlSurfaceContext, payload: unknown) => Promise<unknown>
    }
  >()
  registerOrchestrationHandlers(
    {
      register: (id: string, handler: never) => registered.set(id, handler),
    } as unknown as ControlSurface,
    {
      backend: () => (available.value ? { service, links } : null),
      providerOfNode,
    },
  )
  const call = (id: string, payload: unknown, ctx: Partial<ControlSurfaceContext> = {}) => {
    const handler = registered.get(id)!
    return handler.handle(ctx as ControlSurfaceContext, handler.validate(payload))
  }
  return { service, links, providerOfNode, registered, call, available }
}

const user = {}
const grantCtx = {
  requestAuth: {
    kind: 'session-grant',
    grant: { projectId: 'p1', spaceId: 's1', nodeId: 'orq', sessionId: 'sess', tier: 'interact' },
  },
} as unknown as Partial<ControlSurfaceContext>

const dispatchPayload = { dispatchId: uuid, to: 'exec', text: 'go' }
const userPrincipal = { kind: 'user' }

describe('orchestration handlers', () => {
  it('registers the twelve operations with the declared kind', () => {
    const { registered } = harness()
    expect([...registered.keys()].sort()).toEqual(orchOperations.map(op => op.id).sort())
    for (const op of orchOperations) {
      expect(registered.get(op.id)!.kind).toBe(op.kind)
    }
  })

  it.each([
    ['orch.spawn', { requestId: uuid, provider: 'codex' }, 'spawn', { spawned: true }],
    ['orch.dispatch', dispatchPayload, 'dispatch', { dispatched: true }],
    ['orch.status', { to: 'exec' }, 'status', { linksRevision: 1, links: [] }],
    [
      'orch.cancel',
      { dispatchId: DISPATCH_ID },
      'cancel',
      { dispatchId: DISPATCH_ID, state: 'cancelled' },
    ],
    ['orch.interrupt', { to: 'exec' }, 'interrupt', { ok: true }],
    ['orch.close', { to: 'exec', force: true }, 'close', { ok: true }],
    [
      'orch.link.extend',
      { linkId: LINK_ID, rounds: 1, reason: 'more' },
      'extendRounds',
      { linkId: LINK_ID, roundsLimit: 4 },
    ],
    [
      'orch.approval.respond',
      { executorNodeId: 'exec', requestId: 'r1', decision: 'accept' },
      'respondApproval',
      { ok: true },
    ],
    [
      'orch.hooks.approve',
      { executorNodeId: 'exec', keys: ['k'] },
      'approveHooks',
      { approved: 2, restart: 'scheduled' },
    ],
    [
      'orch.link.create',
      { orchestratorNodeId: 'orq', executorNodeId: 'exec' },
      'createLink',
      { linkId: LINK_ID, runtimeMode: 'service' },
    ],
  ] as const)(
    '%s delegates to the service with the user principal',
    async (id, payload, method, result) => {
      const { service, call } = harness()
      await expect(call(id, payload, user)).resolves.toEqual(result)
      expect(service[method]).toHaveBeenCalledWith(userPrincipal, expect.anything())
    },
  )

  it('refuses with common.unavailable while the service is not composed', async () => {
    const { call, available } = harness()
    available.value = false
    await expect(call('orch.status', {}, user)).rejects.toMatchObject({
      code: 'common.unavailable',
    })
  })

  it('orch.link.close closes through the executor of the link', async () => {
    const { service, call } = harness()
    await expect(call('orch.link.close', { linkId: LINK_ID, force: true }, user)).resolves.toEqual({
      ok: true,
    })
    expect(service.close).toHaveBeenCalledWith(userPrincipal, { to: 'exec', force: true })
    await expect(call('orch.link.close', { linkId: uuid }, user)).rejects.toMatchObject({
      code: 'orch.not_linked',
    })
  })

  it('orch.link.list returns the links with their health and the revision', async () => {
    const { call, links } = harness()
    const result = (await call('orch.link.list', { projectId: 'p1' }, user)) as {
      linksRevision: number
      links: { id: string; health: string }[]
    }
    expect(links.listByProject).toHaveBeenCalledWith('p1')
    expect(result.linksRevision).toBe(9)
    expect(result.links).toMatchObject([{ id: LINK_ID, health: 'ready', executorNodeId: 'exec' }])
  })

  it('builds the agent principal from the grant and the provider read at call time', async () => {
    const { service, call, providerOfNode } = harness()
    await call('orch.dispatch', dispatchPayload, grantCtx)
    expect(providerOfNode).toHaveBeenCalledWith('orq')
    expect(service.dispatch).toHaveBeenCalledWith(
      {
        kind: 'agent',
        nodeId: 'orq',
        projectId: 'p1',
        spaceId: 's1',
        sessionId: 'sess',
        provider: 'claude-code',
        grantActive: true,
      },
      expect.anything(),
    )
  })

  it('an agent that is not an orchestrator cannot close a link by id', async () => {
    const { call, providerOfNode } = harness()
    providerOfNode.mockResolvedValue('codex')
    await expect(call('orch.link.close', { linkId: LINK_ID }, grantCtx)).rejects.toMatchObject({
      code: 'orch.forbidden',
    })
  })

  it('refuses fresh with common.invalid_input and the phase 2 message', () => {
    const { registered } = harness()
    expect.assertions(2)
    try {
      registered.get('orch.dispatch')!.validate({ ...dispatchPayload, fresh: true })
    } catch (error) {
      expect(error).toMatchObject({ code: 'common.invalid_input' })
      expect(String((error as { debugMessage?: string }).debugMessage)).toContain(
        'fresh indisponível na fase 2',
      )
    }
  })

  it('maps orch.dispatch_in_flight with the blocking dispatch as details', async () => {
    const { service, call } = harness()
    const blocking = { dispatchId: DISPATCH_ID, state: 'sent', round: 2 }
    service.dispatch.mockRejectedValue(
      new DispatchRefusedError('orch.dispatch_in_flight', blocking),
    )
    await expect(call('orch.dispatch', dispatchPayload, user)).rejects.toMatchObject({
      code: 'orch.dispatch_in_flight',
      details: blocking,
    })
  })

  it('maps a refusal without a blocking dispatch', async () => {
    const { service, call } = harness()
    service.dispatch.mockRejectedValueOnce(
      new DispatchRefusedError('orch.round_limit_reached', null),
    )
    await expect(call('orch.dispatch', dispatchPayload, user)).rejects.toMatchObject({
      code: 'orch.round_limit_reached',
      details: undefined,
    })
  })

  it.each([
    'orch.forbidden',
    'orch.not_linked',
    'orch.link_invalid',
    'orch.executor_unavailable',
    'orch.approval_not_found',
  ] as const)('maps OrchestrationError %s by code', async code => {
    const { service, call } = harness()
    service.respondApproval.mockRejectedValueOnce(new OrchestrationError(code))
    await expect(
      call(
        'orch.approval.respond',
        { executorNodeId: 'exec', requestId: 'r1', decision: 'accept' },
        user,
      ),
    ).rejects.toMatchObject({ code })
  })

  it('U-09: unmatched selector, other project node and unlinked node refuse with one identical body', async () => {
    const { service, call } = harness()
    const refusals = ['ghost-node', 'node-of-project-b', 'exec-without-link']
    const bodies = await Promise.all(
      refusals.map(async to => {
        service.dispatch.mockRejectedValueOnce(new OrchestrationError('orch.not_linked'))
        const error = (await call('orch.dispatch', { ...dispatchPayload, to }, grantCtx).catch(
          e => e,
        )) as OpenCoveAppError
        return { descriptor: error.toDescriptor(), message: error.message }
      }),
    )
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[2]).toEqual(bodies[0])
    const { descriptor } = bodies[0]
    expect(descriptor).toMatchObject({
      code: 'orch.not_linked',
      debugMessage: expect.stringContaining('No linked executor matches the selector'),
    })
    expect(descriptor.debugMessage).toContain('orch link list')
    expect(descriptor.details).toBeUndefined()
    for (const to of refusals) {
      expect(JSON.stringify(bodies[0])).not.toContain(to)
    }
  })

  it('maps DispatchRuleError to invalid input or an unexpected error', async () => {
    const { service, call } = harness()
    service.dispatch.mockRejectedValueOnce(new DispatchRuleError('invalid_text', 'bad text'))
    await expect(call('orch.dispatch', dispatchPayload, user)).rejects.toMatchObject({
      code: 'common.invalid_input',
    })
    service.dispatch.mockRejectedValueOnce(new DispatchRuleError('invalid_transition', 'bad move'))
    await expect(call('orch.dispatch', dispatchPayload, user)).rejects.toMatchObject({
      code: 'common.unexpected',
    })
  })

  it('leaves unknown errors untouched', async () => {
    const { service, call } = harness()
    const boom = new Error('boom')
    service.status.mockRejectedValueOnce(boom)
    await expect(call('orch.status', {}, user)).rejects.toBe(boom)
  })

  it('declares the hooks approve result schema', () => {
    expect(
      orchestrationHooksApproveResultSchema.safeParse({ approved: 1, restart: 'done' }).success,
    ).toBe(true)
    expect(
      orchestrationHooksApproveResultSchema.safeParse({ approved: 1, restart: 'now' }).success,
    ).toBe(false)
  })
})
