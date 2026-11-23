// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerNodeControlHandlers } from '../../../src/app/main/controlSurface/handlers/nodeControlHandlers'
import { SessionGrantRegistry } from '../../../src/app/main/controlSurface/http/sessionGrantRegistry'
import { notifyAfterStateWrite } from '../../../src/app/main/controlSurface/orchestration/nodeDeletionTrigger'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import type { WorkerTopologyStore } from '../../../src/app/main/controlSurface/topology/topologyStore'
import { createInMemoryPersistenceStore } from '../../contract/controlSurface/controlSurfaceHttpServer.sessionStreaming.testUtils'
import { spawnedHarness } from '../../unit/contexts/orchestration/application/fakes'

const noteNode = (id: string) => ({
  id,
  sessionId: null,
  title: id,
  titlePinnedByUser: false,
  position: { x: 0, y: 0 },
  width: 320,
  height: 240,
  kind: 'note',
  profileId: null,
  runtimeKind: null,
  terminalProviderHint: null,
  labelColorOverride: null,
  status: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  lastError: null,
  executionDirectory: null,
  expectedDirectory: null,
  agent: null,
  task: { text: id },
  scrollback: null,
})

const workspace = (projectId: string, spaceId: string, nodeIds: string[]) => ({
  id: projectId,
  name: projectId,
  path: `/repo/${projectId}`,
  worktreesRoot: `/repo/${projectId}`,
  pullRequestBaseBranchOptions: [],
  spaceArchiveRecords: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  isMinimapVisible: true,
  spaces: [
    {
      id: spaceId,
      name: spaceId,
      directoryPath: `/repo/${projectId}`,
      targetMountId: null,
      labelColor: null,
      nodeIds,
      rect: null,
    },
  ],
  activeSpaceId: spaceId,
  nodes: nodeIds.map(noteNode),
})

async function build() {
  const { harness, executorNodeId, linkId, runtime } = await spawnedHarness()
  const rawStore = createInMemoryPersistenceStore()
  const state = {
    formatVersion: 1,
    activeWorkspaceId: 'project-b',
    workspaces: [
      workspace('project-a', 'space-a', ['orq', 'own-note']),
      workspace('project-b', 'space-b', [executorNodeId, 'b-note']),
    ],
    settings: {},
  }
  await rawStore.writeAppState(state as never)
  const writeAppState = vi.spyOn(rawStore, 'writeAppState')
  const reconcile = async () => {
    const written = (await rawStore.readAppState()) as typeof state
    harness.nodes.clear()
    for (const w of written.workspaces) {
      for (const node of w.nodes) {
        harness.nodes.set(node.id, { nodeId: node.id, provider: 'codex', title: node.title })
      }
    }
    await harness.service.reconcileDeletedNodes()
  }
  const surface = createControlSurface()
  registerNodeControlHandlers(surface, {
    topology: {
      listEndpoints: async () => ({ endpoints: [] }),
      listMounts: async () => ({ mounts: [] }),
    } as unknown as WorkerTopologyStore,
    getPersistenceStore: notifyAfterStateWrite(async () => rawStore, reconcile),
    publishSyncEvent: vi.fn(() => 1),
  })
  const base = { now: () => new Date(), capabilities: {} }
  const grants = new SessionGrantRegistry(() => true)
  const { grant } = grants.issue({
    projectId: 'project-a',
    spaceId: 'space-a',
    nodeId: 'orq',
    sessionId: 'session-a',
  })
  const asGrant = {
    ...base,
    requestAuth: { kind: 'session-grant', grant },
  } as ControlSurfaceContext
  const asBearer = { ...base, requestAuth: { kind: 'bearer' } } as unknown as ControlSurfaceContext
  const asHost = base as unknown as ControlSurfaceContext
  const call = (ctx: ControlSurfaceContext, id: string, payload: unknown) =>
    surface.invoke(ctx, {
      kind:
        id.startsWith('node.') && (id.endsWith('get') || id.endsWith('list')) ? 'query' : 'command',
      id,
      payload,
    } as never)
  return {
    harness,
    executorNodeId,
    linkId,
    runtime,
    writeAppState,
    call,
    asGrant,
    asBearer,
    asHost,
  }
}

const update = (nodeId: string) => ({ nodeId, kind: 'note', title: 'x', data: { text: 'x' } })

describe('I-11 project scope by session grant, end to end', () => {
  it('node.delete of the executor in another project is node.not_found and leaves the link and service alone', async () => {
    const f = await build()
    const foreign = await f.call(f.asGrant, 'node.delete', { nodeId: f.executorNodeId })
    const absent = await f.call(f.asGrant, 'node.delete', { nodeId: 'no-such-node' })
    expect(foreign).toMatchObject({ ok: false, error: { code: 'node.not_found' } })
    expect(foreign).toEqual(absent)
    expect(f.writeAppState).not.toHaveBeenCalled()
    const link = f.harness.links.rows.get(f.linkId)!
    expect(link.closedAt).toBeNull()
    expect(f.runtime.closes).toEqual([])
  })

  it.each(['asBearer', 'asHost'] as const)(
    'the same delete without a scope (%s) closes the link, so the grant result is meaningful',
    async principal => {
      const f = await build()
      const result = await f.call(f[principal], 'node.delete', { nodeId: f.executorNodeId })
      expect(result).toMatchObject({ ok: true })
      expect(f.harness.links.rows.get(f.linkId)!.closedAt).not.toBeNull()
      expect(f.runtime.closes.length).toBeGreaterThan(0)
    },
  )

  it('node.update of another project node is node.not_found and writes nothing', async () => {
    const f = await build()
    const foreign = await f.call(f.asGrant, 'node.update', update('b-note'))
    const absent = await f.call(f.asGrant, 'node.update', update('no-such-node'))
    expect(foreign).toMatchObject({ ok: false, error: { code: 'node.not_found' } })
    expect(foreign).toEqual(absent)
    expect(f.writeAppState).not.toHaveBeenCalled()
    await expect(f.call(f.asBearer, 'node.update', update('b-note'))).resolves.toMatchObject({
      ok: true,
    })
  })

  it('the grant acts in its own project', async () => {
    const f = await build()
    await expect(f.call(f.asGrant, 'node.update', update('own-note'))).resolves.toMatchObject({
      ok: true,
    })
    await expect(f.call(f.asGrant, 'node.delete', { nodeId: 'own-note' })).resolves.toMatchObject({
      ok: true,
    })
    expect(f.harness.links.rows.get(f.linkId)!.closedAt).toBeNull()
  })

  it('node.get, node.list and canvas.focus do not cross projects', async () => {
    const f = await build()
    const get = await f.call(f.asGrant, 'node.get', { nodeId: 'b-note' })
    expect(get).toEqual(await f.call(f.asGrant, 'node.get', { nodeId: 'no-such-node' }))
    expect(get).toMatchObject({ ok: false, error: { code: 'node.not_found' } })

    const list = await f.call(f.asGrant, 'node.list', {})
    const ids = (list as { value: { nodes: { id: string }[] } }).value.nodes.map(n => n.id)
    expect(ids).toEqual(['orq', 'own-note'])
    const foreignList = await f.call(f.asGrant, 'node.list', { projectId: 'project-b' })
    expect((foreignList as { value: { nodes: unknown[] } }).value.nodes).toEqual([])

    const focus = (nodeId: string) =>
      f.call(f.asGrant, 'canvas.focus', { target: { kind: 'node', nodeId } })
    const foreignFocus = await focus('b-note')
    expect(foreignFocus).toEqual(await focus('no-such-node'))
    expect(foreignFocus).toMatchObject({ ok: false, error: { code: 'node.not_found' } })
    await expect(focus('own-note')).resolves.toMatchObject({ ok: true })

    const bearerList = await f.call(f.asBearer, 'node.list', { projectId: 'project-b' })
    expect((bearerList as { value: { nodes: unknown[] } }).value.nodes).toHaveLength(2)
  })
})
