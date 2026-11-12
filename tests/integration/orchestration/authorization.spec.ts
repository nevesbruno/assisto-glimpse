// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import {
  createAgentPromptDelivery,
  registerAgentPromptHandlers,
} from '../../../src/app/main/controlSurface/handlers/agentPromptHandlers'
import { createDirectInputGuard } from '../../../src/app/main/controlSurface/handlers/directInputGuard'
import { registerOrchestrationHandlers } from '../../../src/app/main/controlSurface/handlers/orchestrationHandlers'
import { registerSessionInputHandlers } from '../../../src/app/main/controlSurface/handlers/sessionInputHandlers'
import { SessionGrantRegistry } from '../../../src/app/main/controlSurface/http/sessionGrantRegistry'
import { PtyStreamHub } from '../../../src/app/main/controlSurface/ptyStream/ptyStreamHub'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { AgentProviderRegistry } from '../../../src/contexts/agent/application/services/AgentProviderRegistry'
import { createBuiltinAgentProviderContributions } from '../../../src/contexts/agent/infrastructure/providers/catalog/BuiltinAgentProviderCatalog'
import { grantStateStore } from '../../support/grantStateStore'
import { ORCHESTRATOR_PROVIDER } from '../../../src/contexts/orchestration/domain/agentLink'
import {
  orchestratorPrincipal,
  spawnedHarness,
} from '../../unit/contexts/orchestration/application/fakes'

const DISPATCH_ID = '5b1c0000-0000-4000-8000-000000000003'
const SECOND_SPAWN_ID = '22222222-2222-4222-8222-222222222222'
const user = { now: () => new Date(), capabilities: {} } as unknown as ControlSurfaceContext

async function fixture() {
  const { harness, executorNodeId: executorA } = await spawnedHarness()
  harness.nodes.set('orq-b', { nodeId: 'orq-b', provider: ORCHESTRATOR_PROVIDER, title: 'B' })
  const second = await harness.service.spawn(orchestratorPrincipal('orq-b'), {
    requestId: SECOND_SPAWN_ID,
    provider: 'codex',
  })
  await harness.service.whenIdle()
  const executorB = second.executorNodeId

  let sessionAlive = true
  const grants = new SessionGrantRegistry(() => sessionAlive)
  const providers = new Map<string, string>([
    ['orq', ORCHESTRATOR_PROVIDER],
    ['orq-b', ORCHESTRATOR_PROVIDER],
    [executorA, 'codex'],
    [executorB, 'codex'],
  ])
  const providerOfNode = async (nodeId: string) => providers.get(nodeId) ?? null
  const backend = () => ({ service: harness.service, links: harness.links })

  const registered = new Map<string, { validate: (p: unknown) => unknown; handle: Function }>()
  registerOrchestrationHandlers(
    { register: (id: string, handler: never) => registered.set(id, handler) } as never,
    { backend, providerOfNode },
  )
  const call = (id: string, payload: unknown, ctx: ControlSurfaceContext) => {
    const handler = registered.get(id)!
    return handler.handle(ctx, handler.validate(payload)) as Promise<unknown>
  }
  const grantCtx = (nodeId: string): ControlSurfaceContext => {
    const { grant } = grants.issue({
      projectId: 'p1',
      spaceId: 's1',
      nodeId,
      sessionId: `session-${nodeId}`,
    })
    return {
      ...user,
      requestAuth: { kind: 'session-grant', grant },
      assertActive: () => {
        if (!grants.isActive(grant.grantId)) {
          throw new Error('grant revoked')
        }
      },
    } as unknown as ControlSurfaceContext
  }

  const store = await grantStateStore('p1', ['orq', 'orq-b', executorA, executorB])
  const write = vi.fn()
  const hub = new PtyStreamHub({
    replayWindowMaxBytes: 64000,
    ptyRuntime: {
      write,
      spawnSession: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
    },
  })
  const writeAutomation = vi.spyOn(hub, 'writeAutomation')
  const guard = createDirectInputGuard({ backend, providerOfNode })
  const surface = createControlSurface()
  registerAgentPromptHandlers(
    surface,
    hub,
    createAgentPromptDelivery(
      hub,
      new AgentProviderRegistry(createBuiltinAgentProviderContributions()),
    ),
    guard,
    async () => store,
  )
  registerSessionInputHandlers(surface, {
    getPersistenceStore: async () => store,
    ptyStreamHub: hub,
    guardDirectInput: guard,
  })
  const invoke = (ctx: ControlSurfaceContext, id: string, payload: unknown) =>
    surface.invoke(ctx, { kind: 'command', id, payload })

  const registerRun = (sessionId: string, nodeId: string) =>
    hub.agentRuns.registry.register({ sessionId, nodeId, provider: 'codex', incarnation: 'i' })

  return {
    registerRun,
    call,
    grantCtx,
    invoke,
    write,
    writeAutomation,
    executorA,
    executorB,
    revokeSessions: () => {
      sessionAlive = false
    },
  }
}

describe('I-01 authorization with real grants', () => {
  it('an orchestrator reaches its own executor and never the one of another orchestrator', async () => {
    const f = await fixture()
    const own = { dispatchId: DISPATCH_ID, to: f.executorA, text: 'go' }
    await expect(f.call('orch.dispatch', own, f.grantCtx('orq'))).resolves.toMatchObject({
      state: 'queued',
    })
    await expect(
      f.call('orch.dispatch', { ...own, to: f.executorB }, f.grantCtx('orq')),
    ).rejects.toMatchObject({ code: 'orch.not_linked' })
    await expect(
      f.call('orch.interrupt', { to: f.executorB }, f.grantCtx('orq')),
    ).rejects.toMatchObject({ code: 'orch.not_linked' })
  })

  it('a node of another project is indistinguishable from a node that does not exist', async () => {
    const f = await fixture()
    const refusal = (to: string) =>
      f.call('orch.interrupt', { to }, f.grantCtx('orq')).catch((e: unknown) => e)
    const alien = await refusal(f.executorB)
    const missing = await refusal('node-that-never-existed')
    expect(alien).toMatchObject({ code: 'orch.not_linked' })
    expect(missing).toMatchObject({ code: 'orch.not_linked' })
  })

  it('the grant of an executor receives orch.forbidden', async () => {
    const f = await fixture()
    await expect(f.call('orch.status', {}, f.grantCtx(f.executorA))).rejects.toMatchObject({
      code: 'orch.forbidden',
    })
    await expect(
      f.call(
        'orch.dispatch',
        { dispatchId: DISPATCH_ID, to: f.executorB, text: 'x' },
        f.grantCtx(f.executorA),
      ),
    ).rejects.toMatchObject({ code: 'orch.forbidden' })
  })

  it('a revoked grant is not an active principal', async () => {
    const f = await fixture()
    const ctx = f.grantCtx('orq')
    f.revokeSessions()
    await expect(f.call('orch.status', {}, ctx)).rejects.toMatchObject({ code: 'orch.forbidden' })
  })

  it.each([
    ['orch.link.create', { orchestratorNodeId: 'orq-b', executorNodeId: 'node-x' }],
    ['orch.link.extend', { linkId: DISPATCH_ID, rounds: 1, reason: 'more' }],
    ['orch.link.close', { linkId: DISPATCH_ID }],
    ['orch.approval.respond', { executorNodeId: 'x', requestId: 'r', decision: 'accept' }],
    ['orch.hooks.approve', { executorNodeId: 'x', keys: ['k'] }],
  ])('%s is outside the reach of a grant, whatever the payload says', async (id, payload) => {
    const f = await fixture()
    await expect(f.call(id, payload, f.grantCtx('orq'))).rejects.toMatchObject({
      code: 'orch.forbidden',
    })
  })
})

describe('A7 direct input against a linked executor', () => {
  it('agent.prompt by grant answers orch.use_dispatch and writes nothing to the PTY', async () => {
    const f = await fixture()
    const result = await f.invoke(f.grantCtx('orq'), 'agent.prompt', {
      nodeId: f.executorA,
      text: 'hi',
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'orch.use_dispatch' } })
    expect(f.writeAutomation).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('agent.prompt addressed by sessionId reaches the same guard', async () => {
    const f = await fixture()
    f.registerRun('exec-session', f.executorA)
    const result = await f.invoke(f.grantCtx('orq'), 'agent.prompt', {
      sessionId: 'exec-session',
      text: 'hi',
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'orch.use_dispatch' } })
    expect(f.write).not.toHaveBeenCalled()
  })

  it('session.writeNode by grant answers orch.use_dispatch and writes nothing to the PTY', async () => {
    const f = await fixture()
    const result = await f.invoke(f.grantCtx('orq'), 'session.writeNode', {
      nodeId: f.executorA,
      sessionId: 's',
      data: 'rm -rf',
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'orch.use_dispatch' } })
    expect(f.writeAutomation).not.toHaveBeenCalled()
  })

  it('a node that is not a linked executor is not refused by the guard', async () => {
    const f = await fixture()
    const result = await f.invoke(f.grantCtx('orq'), 'agent.prompt', {
      nodeId: 'plain',
      text: 'hi',
    })
    expect(JSON.stringify(result)).not.toContain('orch.use_dispatch')
  })

  it('the user keeps direct access to the executor', async () => {
    const f = await fixture()
    const result = await f.invoke(user, 'agent.prompt', { nodeId: f.executorA, text: 'hi' })
    expect(JSON.stringify(result)).not.toContain('orch.use_dispatch')
  })
})
