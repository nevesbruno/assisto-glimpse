// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  assertNodeInGrantProject,
  assertProjectInGrant,
  assertSpaceInGrantProject,
  grantProjectOf,
} from '../../../src/app/main/controlSurface/handlers/grantProjectScope'
import { toAppErrorDescriptor } from '../../../src/shared/errors/appError'
import { resolveAdmittedMountAgentLaunch } from '../../../src/app/main/controlSurface/handlers/resolveAdmittedMountAgentLaunch'
import { resolveCanvasSpawnIdentity } from '../../../src/app/main/controlSurface/resolveCanvasSpawnIdentity'
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
      sessionId: 'sess',
      grantId: 'g',
      tier: 'interact',
      createdAt: '',
    },
  },
})
const plainCtx: ControlSurfaceContext = { now: () => new Date() }
const bearerCtx: ControlSurfaceContext = { now: () => new Date(), requestAuth: { kind: 'bearer' } }

async function twoProjectStore() {
  const store = createInMemoryPersistenceStore()
  const state = createMinimalState('/a', 'project-a', 's-a')
  const other = createMinimalState('/b', 'project-b', 's-b').workspaces[0]
  Object.assign(other, {
    nodes: [
      { id: 'n-b', kind: 'terminal', title: 't', position: { x: 0, y: 0 }, width: 1, height: 1 },
    ],
  })
  Object.assign(other.spaces[0], { nodeIds: ['n-b'] })
  state.workspaces.push(other)
  await store.writeAppState(state)
  return store
}

describe('grant project helper', () => {
  const state = {
    workspaces: [
      { id: 'a', nodes: [{ id: 'na' }], spaces: [{ id: 'sa' }] },
      { id: 'b', nodes: [{ id: 'nb' }], spaces: [{ id: 'sb' }] },
    ],
  }
  it('is a no-op without a grant', () => {
    for (const ctx of [plainCtx, bearerCtx]) {
      expect(grantProjectOf(ctx)).toBeUndefined()
      expect(() => assertProjectInGrant(ctx, 'b', 'common.invalid_input')).not.toThrow()
      expect(() => assertNodeInGrantProject(ctx, state, 'nb', 'node.not_found')).not.toThrow()
      expect(() => assertSpaceInGrantProject(ctx, state, 'sb', 'space.not_found')).not.toThrow()
    }
  })
  it('carries the optional debugMessage on every assertion', () => {
    const ctx = grantCtx('a')
    const debugMessage = 'Unknown target'
    const denied = [
      () => assertProjectInGrant(ctx, 'b', 'common.invalid_input', debugMessage),
      () => assertNodeInGrantProject(ctx, state, 'nb', 'common.invalid_input', debugMessage),
      () => assertSpaceInGrantProject(ctx, state, 'sb', 'common.invalid_input', debugMessage),
    ]
    for (const assertion of denied) {
      expect(assertion).toThrow(expect.objectContaining({ debugMessage }))
    }
  })
  it('allows the grant project and denies everything else with the given code', () => {
    const ctx = grantCtx('a')
    expect(grantProjectOf(ctx)).toBe('a')
    expect(() => assertProjectInGrant(ctx, 'a', 'common.invalid_input')).not.toThrow()
    expect(() => assertNodeInGrantProject(ctx, state, 'na', 'node.not_found')).not.toThrow()
    expect(() => assertSpaceInGrantProject(ctx, state, 'sa', 'space.not_found')).not.toThrow()
    expect(() => assertProjectInGrant(ctx, 'b', 'common.invalid_input')).toThrow(
      expect.objectContaining({ code: 'common.invalid_input' }),
    )
    expect(() => assertProjectInGrant(ctx, undefined, 'common.invalid_input')).toThrow()
    expect(() => assertNodeInGrantProject(ctx, state, 'nb', 'node.not_found')).toThrow(
      expect.objectContaining({ code: 'node.not_found' }),
    )
    expect(() => assertNodeInGrantProject(ctx, state, 'ghost', 'node.not_found')).toThrow()
    expect(() => assertSpaceInGrantProject(ctx, state, 'sb', 'space.not_found')).toThrow(
      expect.objectContaining({ code: 'space.not_found' }),
    )
  })
})

describe('spawn identity under a grant', () => {
  it.each([
    ['workspaceId of another project', { workspaceId: 'project-b' }],
    ['spaceId of another project', { spaceId: 's-b' }],
    ['workspaceId and spaceId of another project', { workspaceId: 'project-b', spaceId: 's-b' }],
    ['unknown workspaceId', { workspaceId: 'ghost' }],
  ])('refuses %s with the unknown-target error', async (_name, payload) => {
    const store = await twoProjectStore()
    await expect(
      resolveCanvasSpawnIdentity(grantCtx('project-a'), payload, async () => store),
    ).rejects.toMatchObject({ code: 'common.invalid_input' })
  })

  it('resolves the own project and uses it implicitly when no target is given', async () => {
    const store = await twoProjectStore()
    const ctx = grantCtx('project-a')
    expect(
      await resolveCanvasSpawnIdentity(
        ctx,
        { workspaceId: 'project-a', spaceId: 's-a' },
        async () => store,
      ),
    ).toMatchObject({ projectId: 'project-a', spaceId: 's-a' })
    expect(
      await resolveCanvasSpawnIdentity(ctx, { spaceId: 's-a' }, async () => store),
    ).toMatchObject({
      projectId: 'project-a',
    })
    expect(await resolveCanvasSpawnIdentity(ctx, {}, async () => store)).toMatchObject({
      projectId: 'project-a',
      spaceId: '',
    })
  })

  it.each([
    ['user', plainCtx],
    ['bearer', bearerCtx],
  ])('leaves %s identity untouched', async (_name, ctx) => {
    const store = await twoProjectStore()
    const getStore = async () => store
    expect(
      await resolveCanvasSpawnIdentity(ctx, { workspaceId: 'project-b' }, getStore),
    ).toMatchObject({ projectId: 'project-b' })
    expect(await resolveCanvasSpawnIdentity(ctx, {}, getStore)).toBeUndefined()
  })

  it('refuses an internal spawn identity of another project and keeps the own one', async () => {
    const store = await twoProjectStore()
    const foreign = { projectId: 'project-b', spaceId: 's-b', nodeId: 'n-b' }
    const own = { projectId: 'project-a', spaceId: 's-a', nodeId: 'n-a' }
    await expect(
      resolveCanvasSpawnIdentity(
        { ...grantCtx('project-a'), spawnIdentity: foreign },
        {},
        async () => store,
      ),
    ).rejects.toMatchObject({ code: 'common.invalid_input' })
    expect(
      await resolveCanvasSpawnIdentity(
        { ...grantCtx('project-a'), spawnIdentity: own },
        {},
        async () => store,
      ),
    ).toBe(own)
    expect(
      await resolveCanvasSpawnIdentity(
        { ...bearerCtx, spawnIdentity: foreign },
        {},
        async () => store,
      ),
    ).toBe(foreign)
  })

  it('only yields identities of the grant project, the only input of grants.reserve', async () => {
    const store = await twoProjectStore()
    const reserve = vi.fn()
    const attempt = async (payload: unknown) => {
      const identity = await resolveCanvasSpawnIdentity(
        grantCtx('project-a'),
        payload,
        async () => store,
      )
      reserve(identity)
    }
    await attempt({ workspaceId: 'project-b' }).catch(() => undefined)
    await attempt({ spaceId: 's-b' }).catch(() => undefined)
    await attempt({})
    await attempt({ workspaceId: 'project-a' })
    expect(reserve.mock.calls.map(([identity]) => identity.projectId)).toEqual([
      'project-a',
      'project-a',
    ])
  })
})

describe('launchAgentInMount under a grant', () => {
  const run = (ctx: ControlSurfaceContext, projectId: string) => {
    const assertSpawnAllowed = vi.fn()
    const result = resolveAdmittedMountAgentLaunch({
      ctx,
      payload: { mountId: 'm', prompt: 'p' } as never,
      topology: {
        resolveMountTarget: async () => ({ projectId, endpointId: 'local', rootUri: 'file:///r' }),
      } as never,
      admission: { assertSpawnAllowed } as never,
    })
    return { result, assertSpawnAllowed }
  }
  it('refuses a mount of another project before admission', async () => {
    const { result, assertSpawnAllowed } = run(grantCtx('project-a'), 'project-b')
    await expect(result).rejects.toMatchObject({ code: 'common.invalid_input' })
    expect(assertSpawnAllowed).not.toHaveBeenCalled()
  })
  it('answers a mount of another project exactly like an unknown mount', async () => {
    const attempt = (resolved: boolean) =>
      resolveAdmittedMountAgentLaunch({
        ctx: grantCtx('project-a'),
        payload: { mountId: 'm', prompt: 'p' } as never,
        topology: {
          resolveMountTarget: async () =>
            resolved ? { projectId: 'project-b', endpointId: 'local', rootUri: 'file:///r' } : null,
        } as never,
        admission: { assertSpawnAllowed: vi.fn() } as never,
      }).catch(error => toAppErrorDescriptor(error))
    const foreign = await attempt(true)
    expect(foreign).toMatchObject({
      code: 'common.invalid_input',
      debugMessage: 'Unknown mountId: m',
    })
    expect(foreign).toEqual(await attempt(false))
  })
  it('accepts the own project mount and non-grant callers', async () => {
    await expect(run(grantCtx('project-a'), 'project-a').result).resolves.toMatchObject({
      mode: 'new',
    })
    await expect(run(bearerCtx, 'project-b').result).resolves.toMatchObject({ mode: 'new' })
  })
})
