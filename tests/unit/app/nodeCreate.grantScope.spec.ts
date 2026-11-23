// @vitest-environment node
import { expect, it, vi } from 'vitest'
import {
  createNodeForNodeControl,
  type NodeControlRuntimeDeps,
} from '../../../src/contexts/workspace/application/nodeControl/nodeControlUseCases'
import type { NodeControlAppState } from '../../../src/contexts/workspace/application/nodeControl/nodeControlState'

const space = (id: string) => ({
  id,
  name: id,
  directoryPath: '/repo',
  targetMountId: null,
  labelColor: null,
  nodeIds: [],
  rect: null,
})
const workspace = (id: string, spaceId: string) => ({
  id,
  name: id,
  path: '/repo',
  worktreesRoot: '',
  pullRequestBaseBranchOptions: [],
  environmentVariables: {},
  spaceArchiveRecords: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  isMinimapVisible: true,
  spaces: [space(spaceId)],
  activeSpaceId: spaceId,
  nodes: [],
})
const state: NodeControlAppState = {
  formatVersion: 1,
  activeWorkspaceId: 'project-b',
  workspaces: [workspace('project-a', 'space-a'), workspace('project-b', 'space-b')],
  settings: {},
}
const endpoint = {
  endpointId: 'local',
  kind: 'local' as const,
  displayName: 'Local',
  createdAt: '',
  updatedAt: '',
  remote: null,
}
const mount = {
  mountId: 'm',
  projectId: 'project-a',
  name: 'm',
  sortOrder: 0,
  endpointId: 'local',
  targetId: 't',
  rootPath: '/repo',
  rootUri: 'file:///repo',
  createdAt: '',
}

function setup() {
  const spawnTerminal = vi.fn(async () => ({
    sessionId: 's',
    executionDirectory: '/repo',
    expectedDirectory: '/repo',
    startedAt: '',
    profileId: 'default',
    runtimeKind: 'posix' as const,
  }))
  const runtime: NodeControlRuntimeDeps = {
    launchAgent: vi.fn() as never,
    spawnTerminal,
    killSession: async () => undefined,
  }
  const writeAppState = vi.fn(async () => ({ ok: true, level: 'full', bytes: 1, revision: 2 }))
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => 1,
    writeAppState,
  } as never
  const locatorDeps = {
    listEndpoints: async () => [endpoint],
    listMounts: async () => [mount],
    listWorktreesForMount: async () => [],
    listWorktreesForWorkspace: async () => [],
  } as never
  const create = (input: object, projectScope?: string) =>
    createNodeForNodeControl({
      store,
      locatorDeps,
      runtime,
      projectScope,
      now: new Date(),
      input: { kind: 'terminal', data: { profileId: 'default' }, ...input } as never,
    })
  return { create, spawnTerminal, writeAppState }
}

it.each([
  ['spaceId of another project', { space: { kind: 'spaceId', spaceId: 'space-b' } }],
  ['projectId of another project', { projectId: 'project-b' }],
  [
    'space and projectId of another project',
    { projectId: 'project-b', space: { kind: 'spaceId', spaceId: 'space-b' } },
  ],
])('grant of project A creating with %s fails without spawning or writing', async (_n, input) => {
  const { create, spawnTerminal, writeAppState } = setup()
  await expect(create(input, 'project-a')).rejects.toBeTruthy()
  expect(spawnTerminal).not.toHaveBeenCalled()
  expect(writeAppState).not.toHaveBeenCalled()
})

it('grant creates in its own project and unscoped callers still reach any project', async () => {
  const own = setup()
  await expect(
    own.create({ space: { kind: 'spaceId', spaceId: 'space-a' } }, 'project-a'),
  ).resolves.toMatchObject({ projectId: 'project-a' })
  const any = setup()
  await expect(
    any.create({ space: { kind: 'spaceId', spaceId: 'space-b' } }),
  ).resolves.toMatchObject({ projectId: 'project-b' })
})
