// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAppError } from '../../../src/shared/errors/appError'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerAgentPromptHandlers } from '../../../src/app/main/controlSurface/handlers/agentPromptHandlers'
import { registerAgentRunStateHandlers } from '../../../src/app/main/controlSurface/handlers/agentRunStateHandlers'
import { registerSessionGetKillHandlers } from '../../../src/app/main/controlSurface/handlers/sessionGetKillHandlers'
import { registerSessionInputHandlers } from '../../../src/app/main/controlSurface/handlers/sessionInputHandlers'
import { registerSpaceHandlers } from '../../../src/app/main/controlSurface/handlers/spaceHandlers'
import { createSessionNodeResolver } from '../../../src/app/main/controlSurface/handlers/sessionNodeResolver'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import {
  createInMemoryPersistenceStore,
  createMinimalState,
} from '../../contract/controlSurface/controlSurfaceHttpServer.sessionStreaming.testUtils'

const grantCtx = (projectId: string): ControlSurfaceContext => ({
  now: () => new Date(),
  requestAuth: {
    kind: 'session-grant',
    grant: {
      projectId,
      spaceId: 's-a',
      nodeId: 'n-a',
      sessionId: 'sess-a',
      grantId: 'g',
      tier: 'interact',
      createdAt: '',
    },
  },
})
const userCtx: ControlSurfaceContext = { now: () => new Date() }
const bearerCtx: ControlSurfaceContext = { now: () => new Date(), requestAuth: { kind: 'bearer' } }
const grantA = grantCtx('project-a')

const terminal = (id: string, sessionId: string) => ({
  id,
  sessionId,
  title: id,
  kind: 'terminal',
  position: { x: 0, y: 0 },
  width: 300,
  height: 200,
  labelColorOverride: null,
  status: 'running',
  startedAt: null,
  endedAt: null,
  exitCode: null,
  lastError: null,
  agent: null,
  task: null,
  scrollback: null,
})

async function twoProjectStore() {
  const store = createInMemoryPersistenceStore()
  const state = createMinimalState('/a', 'project-a', 's-a')
  const other = createMinimalState('/b', 'project-b', 's-b').workspaces[0]
  Object.assign(state.workspaces[0], { nodes: [terminal('n-a', 'sess-a')] })
  Object.assign(other, { nodes: [terminal('n-b', 'sess-b')] })
  Object.assign(state.workspaces[0].spaces[0], {
    nodeIds: ['n-a'],
    rect: { x: -50, y: -50, width: 600, height: 400 },
  })
  Object.assign(other.spaces[0], { nodeIds: ['n-b'] })
  state.workspaces.push(other)
  await store.writeAppState(state)
  return store
}

const invoke = (
  control: ReturnType<typeof createControlSurface>,
  ctx: ControlSurfaceContext,
  kind: 'query' | 'command',
  id: string,
  payload: unknown,
) => control.invoke(ctx, { kind, id, payload } as never)
const errorCode = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? null : (result.error as { code: string }).code

/** Full error descriptor with the requested id masked: the only legitimate difference between targets. */
const maskedDescriptor = (result: unknown, requestedId: string) =>
  JSON.parse(JSON.stringify(result).split(requestedId).join('<id>'))

describe('session operations under a grant', () => {
  async function setup() {
    const store = await twoProjectStore()
    const control = createControlSurface()
    const kill = vi.fn()
    const writeAutomation = vi.fn()
    const guardDirectInput = vi.fn(async () => undefined)
    const hub = {
      getSessionMetadata: () => null,
      hasSession: () => true,
      writeAutomation,
    }
    const ptyRuntime = { kill, getSessionRoute: () => undefined }
    const getPersistenceStore = async () => store
    const resolveNode = createSessionNodeResolver({
      getPersistenceStore,
      ptyStreamHub: hub,
      ptyRuntime,
      topology: { listMounts: async () => ({ mounts: [] }) },
    } as never)
    const sessions = new Map([
      ['sess-a', { sessionId: 'sess-a' }],
      ['sess-b', { sessionId: 'sess-b' }],
    ])
    registerSessionGetKillHandlers(control, {
      getPersistenceStore,
      ptyStreamHub: hub,
      ptyRuntime,
      sessions,
      resolveNode,
    } as never)
    registerSessionInputHandlers(control, {
      getPersistenceStore,
      ptyStreamHub: hub as never,
      guardDirectInput,
    })
    return { control, kill, writeAutomation, guardDirectInput }
  }

  it('answers session.get and kill for another project like an unknown target', async () => {
    const { control, kill } = await setup()
    const cases = [
      ['query', 'session.get', { nodeId: 'n-b' }, { nodeId: 'ghost' }],
      ['query', 'session.get', { sessionId: 'sess-b' }, { sessionId: 'ghost' }],
      ['command', 'session.kill', { nodeId: 'n-b' }, { nodeId: 'ghost' }],
      ['command', 'session.kill', { sessionId: 'sess-b' }, { sessionId: 'ghost' }],
    ] as const
    await Promise.all(
      cases.map(async ([kind, id, foreign, unknown]) => {
        const denied = await invoke(control, grantA, kind, id, foreign)
        const absent = await invoke(control, grantA, kind, id, unknown)
        expect(errorCode(denied)).toBe('session.not_found')
        expect(maskedDescriptor(denied, Object.values(foreign)[0])).toEqual(
          maskedDescriptor(absent, Object.values(unknown)[0]),
        )
      }),
    )
    expect(kill).not.toHaveBeenCalled()
  })

  it('keeps own project, user and bearer working', async () => {
    const { control, kill } = await setup()
    const reads = [
      [grantA, { nodeId: 'n-a' }],
      [grantA, { sessionId: 'sess-a' }],
      [userCtx, { nodeId: 'n-b' }],
      [userCtx, { sessionId: 'sess-b' }],
      [bearerCtx, { nodeId: 'n-b' }],
      [bearerCtx, { sessionId: 'sess-b' }],
    ] as const
    const results = await Promise.all(
      reads.map(([ctx, payload]) => invoke(control, ctx, 'query', 'session.get', payload)),
    )
    expect(results.map(result => result.ok)).toEqual(reads.map(() => true))
    expect((await invoke(control, grantA, 'command', 'session.kill', { nodeId: 'n-a' })).ok).toBe(
      true,
    )
    expect(kill).toHaveBeenCalledWith('sess-a')
  })

  it('refuses stopNode and writeNode on another project before the guard and the write', async () => {
    const { control, kill, writeAutomation, guardDirectInput } = await setup()
    const stop = await invoke(control, grantA, 'command', 'session.stopNode', {
      nodeId: 'n-b',
      sessionId: 'sess-b',
    })
    const write = await invoke(control, grantA, 'command', 'session.writeNode', {
      nodeId: 'n-b',
      sessionId: 'sess-b',
      data: 'x',
    })
    expect(errorCode(stop)).toBe('session.not_found')
    expect(errorCode(write)).toBe('session.not_found')
    expect(guardDirectInput).not.toHaveBeenCalled()
    expect(writeAutomation).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    const own = await invoke(control, grantA, 'command', 'session.writeNode', {
      nodeId: 'n-a',
      sessionId: 'sess-a',
      data: 'x',
    })
    expect(own.ok).toBe(true)
    expect(guardDirectInput).toHaveBeenCalledTimes(1)
  })
})

describe('agent operations under a grant', () => {
  const snapshot = (nodeId: string, sessionId: string) => ({ nodeId, sessionId })
  async function setup() {
    const store = await twoProjectStore()
    const control = createControlSurface()
    const agents = [snapshot('n-a', 'sess-a'), snapshot('n-b', 'sess-b')]
    const registry = {
      get: vi.fn((locator: { nodeId?: string; sessionId?: string }) =>
        agents.find(a =>
          locator.nodeId ? a.nodeId === locator.nodeId : a.sessionId === locator.sessionId,
        ),
      ),
      list: vi.fn((filter: { projectId?: string }) => ({
        agents: filter.projectId === 'project-a' ? [agents[0]] : agents,
      })),
      finalMessage: vi.fn((input: { nodeId?: string; sessionId?: string }) => {
        const known = agents.some(a => a.nodeId === input.nodeId || a.sessionId === input.sessionId)
        if (!known) {
          throw createAppError('agent.final_message_unavailable', {
            details: { reason: 'no_ended_turn' },
          })
        }
        return { sessionId: input.sessionId ?? 's', turnId: 't' }
      }),
      clearHistory: vi.fn((nodeId: string) => ({
        nodeId,
        memoryRemoved: 0,
        archive: { status: 'cleared' },
      })),
    }
    const hub = { agentRuns: { registry } } as never
    const deliver = vi.fn(async () => ({ deliveryId: 'd' }))
    const deliveryGet = vi.fn((deliveryId: string) => ({
      available: true,
      deliveryId,
      nodeId: deliveryId === 'd-b' ? 'n-b' : 'n-a',
    }))
    const guard = vi.fn(async () => undefined)
    const readStore = async () => store
    registerAgentPromptHandlers(
      control,
      hub,
      { deliver, get: deliveryGet } as never,
      guard,
      readStore,
    )
    registerAgentRunStateHandlers(control, hub, undefined, readStore)
    return { control, registry, deliver, guard }
  }

  it('refuses agent.prompt to another project as a missing agent', async () => {
    const { control, deliver, guard } = await setup()
    const refused = await Promise.all(
      [
        { nodeId: 'n-b', text: 'hi' },
        { sessionId: 'sess-b', text: 'hi' },
        { sessionId: 'ghost', text: 'hi' },
      ].map(payload => invoke(control, grantA, 'command', 'agent.prompt', payload)),
    )
    expect(refused.map(errorCode)).toEqual(refused.map(() => 'agent.not_running'))
    expect(deliver).not.toHaveBeenCalled()
    expect(guard).not.toHaveBeenCalled()
    const allowed = await Promise.all(
      [
        { nodeId: 'n-a', text: 'hi' },
        { nodeId: '@self', text: 'hi' },
        { sessionId: 'sess-a', text: 'hi' },
      ].map(payload => invoke(control, grantA, 'command', 'agent.prompt', payload)),
    )
    expect(allowed.map(result => result.ok)).toEqual([true, true, true])
    expect(deliver).toHaveBeenCalledTimes(3)
    expect(
      (await invoke(control, userCtx, 'command', 'agent.prompt', { nodeId: 'n-b', text: 'h' })).ok,
    ).toBe(true)
  })

  it('hides state, final message, history and delivery of another project', async () => {
    const { control, registry } = await setup()
    expect(await invoke(control, grantA, 'query', 'agent.get', { nodeId: 'n-b' })).toMatchObject({
      ok: true,
      value: null,
    })
    expect(
      await invoke(control, grantA, 'query', 'agent.get', { sessionId: 'sess-b' }),
    ).toMatchObject({
      ok: true,
      value: null,
    })
    expect((await invoke(control, grantA, 'query', 'agent.get', { nodeId: 'n-a' })).ok).toBe(true)
    const finals = await Promise.all(
      [{ nodeId: 'n-b' }, { sessionId: 'sess-b' }].map(payload =>
        invoke(control, grantA, 'query', 'agent.finalMessage', payload),
      ),
    )
    expect(finals.map(errorCode)).toEqual(finals.map(() => 'agent.final_message_unavailable'))
    expect(registry.finalMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'n-b' }),
    )
    expect(registry.finalMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-b' }),
    )
    const cleared = await invoke(control, grantA, 'command', 'agent.history.clear', {
      nodeId: 'n-b',
    })
    expect(cleared).toMatchObject({ ok: true, value: { nodeId: 'n-b', memoryRemoved: 0 } })
    expect(registry.clearHistory).not.toHaveBeenCalledWith('n-b')
    expect(
      (await invoke(control, grantA, 'command', 'agent.history.clear', { nodeId: 'n-a' })).ok,
    ).toBe(true)
    expect(registry.clearHistory).toHaveBeenCalledWith('n-a')
    expect(
      await invoke(control, grantA, 'query', 'agent.delivery.get', { deliveryId: 'd-b' }),
    ).toMatchObject({
      ok: true,
      value: { available: false, deliveryId: 'd-b', reason: 'unavailable' },
    })
    expect(
      await invoke(control, grantA, 'query', 'agent.delivery.get', { deliveryId: 'd-a' }),
    ).toMatchObject({
      ok: true,
      value: { available: true },
    })
  })

  it('filters agent.list by the grant project and ignores a foreign projectId', async () => {
    const { control } = await setup()
    const own = await invoke(control, grantA, 'query', 'agent.list', {})
    expect(own).toMatchObject({ ok: true, value: { agents: [{ nodeId: 'n-a' }] } })
    const foreign = await invoke(control, grantA, 'query', 'agent.list', { projectId: 'project-b' })
    expect(foreign).toMatchObject({ ok: true, value: { agents: [] } })
    const user = await invoke(control, userCtx, 'query', 'agent.list', {})
    expect((user as { value: { agents: unknown[] } }).value.agents).toHaveLength(2)
  })
})

describe('space operations under a grant', () => {
  async function setup() {
    const store = await twoProjectStore()
    const control = createControlSurface()
    registerSpaceHandlers(control, async () => store)
    return { control, store }
  }

  it('hides spaces of another project and lists only the grant project', async () => {
    const { control } = await setup()
    const denied = await invoke(control, grantA, 'query', 'space.get', { spaceId: 's-b' })
    const absent = await invoke(control, grantA, 'query', 'space.get', { spaceId: 'ghost' })
    expect(errorCode(denied)).toBe('space.not_found')
    expect(errorCode(absent)).toBe('space.not_found')
    expect(maskedDescriptor(denied, 's-b')).toEqual(maskedDescriptor(absent, 'ghost'))
    expect((await invoke(control, grantA, 'query', 'space.get', { spaceId: 's-a' })).ok).toBe(true)
    expect((await invoke(control, userCtx, 'query', 'space.get', { spaceId: 's-b' })).ok).toBe(true)

    const own = await invoke(control, grantA, 'query', 'space.list', {})
    expect(own).toMatchObject({ ok: true, value: { projectId: 'project-a' } })
    const foreign = await invoke(control, grantA, 'query', 'space.list', { projectId: 'project-b' })
    expect(foreign).toMatchObject({ ok: true, value: { spaces: [] } })
    const user = await invoke(control, userCtx, 'query', 'space.list', { projectId: 'project-b' })
    expect((user as { value: { spaces: unknown[] } }).value.spaces).toHaveLength(1)
  })

  it('refuses createChild under another project without writing', async () => {
    const { control, store } = await setup()
    const before = await store.readAppStateRevision()
    const refused = await Promise.all(
      [
        { parentSpaceId: 's-b' },
        { parentSpaceId: 's-b', projectId: 'project-b' },
        { parentSpaceId: 's-a', projectId: 'project-b' },
      ].map(payload => invoke(control, grantA, 'command', 'space.createChild', payload)),
    )
    expect(refused.map(errorCode)).toEqual(refused.map(() => 'space.not_found'))
    expect(await store.readAppStateRevision()).toBe(before)
    const own = await invoke(control, grantA, 'command', 'space.createChild', {
      parentSpaceId: 's-a',
      initialNodeIds: ['n-a'],
    })
    expect(own).toMatchObject({ ok: true, value: { projectId: 'project-a' } })
  })
})
