import { describe, expect, it, vi } from 'vitest'
import { deleteNodeForNodeControl } from '../../../src/contexts/workspace/application/nodeControl/nodeControlDelete'
import { updateNodeForNodeControl } from '../../../src/contexts/workspace/application/nodeControl/nodeControlUpdate'
import { resolveCanvasFocusTargetForNodeControl } from '../../../src/contexts/workspace/application/nodeControl/nodeControlFocus'
import {
  getNodeForNodeControl,
  listNodesForNodeControl,
} from '../../../src/contexts/workspace/application/nodeControl/nodeControlUseCases'
import type {
  NodeControlAppState,
  NodeControlAppStateStore,
  NodeControlNode,
} from '../../../src/contexts/workspace/application/nodeControl/nodeControlState'
import type { SpaceLocatorResolverDeps } from '../../../src/contexts/workspace/application/nodeControl/spaceLocator'

const SCOPE = 'project-a'

function note(id: string): NodeControlNode {
  return {
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
  }
}

function workspace(projectId: string, spaceId: string, nodeId: string) {
  return {
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
        nodeIds: [nodeId],
        rect: null,
      },
    ],
    activeSpaceId: spaceId,
    nodes: [note(nodeId)],
  }
}

function fixture() {
  const state = {
    formatVersion: 1,
    activeWorkspaceId: 'project-b',
    workspaces: [
      workspace(SCOPE, 'space-a', 'node-a'),
      workspace('project-b', 'space-b', 'node-b'),
    ],
    settings: {},
  } as unknown as NodeControlAppState
  const writeAppState = vi.fn(async () => ({
    ok: true as const,
    level: 'full' as const,
    bytes: 1,
    revision: 2,
  }))
  const store: NodeControlAppStateStore = {
    readAppState: async () => state,
    readAppStateRevision: async () => 1,
    writeAppState,
  }
  const locatorDeps: SpaceLocatorResolverDeps = {
    listMounts: async () => [],
    listEndpoints: async () => [],
    listWorktreesForMount: async () => [],
    listWorktreesForWorkspace: async () => [],
  }
  const runtime = { killSession: vi.fn(), closeWebsiteNode: vi.fn(), closePluginNode: vi.fn() }
  return { store, locatorDeps, runtime, writeAppState }
}

async function failureOf(run: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await run()
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected a failure')
}

describe('I-11 project scope on node operations', () => {
  const now = new Date('2026-11-11T00:00:00.000Z')
  const updateInput = (nodeId: string) =>
    ({ nodeId, kind: 'note', title: 'hijacked', data: { text: 'hijacked' } }) as const

  it('node.delete of another project looks exactly like an absent id and writes nothing', async () => {
    const f = fixture()
    const run = (nodeId: string) => () =>
      deleteNodeForNodeControl({ ...f, input: { nodeId }, projectScope: SCOPE, now })
    const foreign = await failureOf(run('node-b'))
    const absent = await failureOf(run('node-absent'))
    expect(foreign.code).toBe('node.not_found')
    expect(foreign).toEqual(absent)
    expect(f.writeAppState).not.toHaveBeenCalled()
    expect(f.runtime.killSession).not.toHaveBeenCalled()
  })

  it('node.update of another project looks exactly like an absent id and writes nothing', async () => {
    const f = fixture()
    const run = (nodeId: string) => () =>
      updateNodeForNodeControl({ store: f.store, input: updateInput(nodeId), projectScope: SCOPE })
    const foreign = await failureOf(run('node-b'))
    const absent = await failureOf(run('node-absent'))
    expect(foreign.code).toBe('node.not_found')
    expect(foreign).toEqual(absent)
    expect(f.writeAppState).not.toHaveBeenCalled()
  })

  it('the grant still deletes and updates in its own project, keeping the other project intact', async () => {
    const f = fixture()
    await updateNodeForNodeControl({
      store: f.store,
      input: updateInput('node-a'),
      projectScope: SCOPE,
    })
    const deleted = await deleteNodeForNodeControl({
      ...f,
      input: { nodeId: 'node-a' },
      projectScope: SCOPE,
      now,
    })
    expect(deleted).toMatchObject({ projectId: SCOPE, nodeId: 'node-a' })
    const written = f.writeAppState.mock.calls.at(-1)![0] as NodeControlAppState
    expect(written.workspaces.map(w => w.id)).toEqual([SCOPE, 'project-b'])
    expect(written.workspaces[1].nodes.map(n => n.id)).toEqual(['node-b'])
  })

  it('without a scope (user, bearer, plugin canvas host) every project is reachable', async () => {
    const f = fixture()
    await expect(
      deleteNodeForNodeControl({ ...f, input: { nodeId: 'node-b' }, now }),
    ).resolves.toMatchObject({ projectId: 'project-b' })
    await expect(
      updateNodeForNodeControl({ store: f.store, input: updateInput('node-b') }),
    ).resolves.toMatchObject({ node: { id: 'node-b' } })
  })

  it('node.get of another project looks like an absent id', async () => {
    const f = fixture()
    const run = (nodeId: string) => () =>
      getNodeForNodeControl({ store: f.store, input: { nodeId }, projectScope: SCOPE })
    expect(await failureOf(run('node-b'))).toEqual(await failureOf(run('node-absent')))
    await expect(run('node-a')()).resolves.toMatchObject({ node: { id: 'node-a' } })
  })

  it('node.list never returns another project, nor reveals its active id', async () => {
    const f = fixture()
    const scoped = await listNodesForNodeControl({ ...f, input: {}, projectScope: SCOPE })
    expect(scoped.projectId).toBe(SCOPE)
    expect(scoped.nodes.map(n => n.id)).toEqual(['node-a'])
    const foreign = await listNodesForNodeControl({
      ...f,
      input: { projectId: 'project-b' },
      projectScope: SCOPE,
    })
    expect(foreign.nodes).toEqual([])
    const bySpace = await failureOf(() =>
      listNodesForNodeControl({
        ...f,
        input: { space: { kind: 'spaceId', spaceId: 'space-b' } },
        projectScope: SCOPE,
      }),
    )
    expect(bySpace.code).toBe('space.not_found')
    const unscoped = await listNodesForNodeControl({ ...f, input: { projectId: 'project-b' } })
    expect(unscoped.nodes.map(n => n.id)).toEqual(['node-b'])
  })

  it('canvas.focus on another project node or space looks like an absent target', async () => {
    const f = fixture()
    const focus = (
      target: Parameters<typeof resolveCanvasFocusTargetForNodeControl>[0]['target'],
    ) => resolveCanvasFocusTargetForNodeControl({ ...f, target, projectScope: SCOPE })
    const node = (nodeId: string) => () => focus({ kind: 'node', nodeId })
    expect(await failureOf(node('node-b'))).toEqual(await failureOf(node('node-absent')))
    const space = (spaceId: string) => () =>
      focus({ kind: 'space', locator: { kind: 'spaceId', spaceId } })
    expect(await failureOf(space('space-b'))).toEqual(await failureOf(space('space-absent')))
    await expect(focus({ kind: 'node', nodeId: 'node-a' })).resolves.toMatchObject({
      projectId: SCOPE,
    })
  })
})
