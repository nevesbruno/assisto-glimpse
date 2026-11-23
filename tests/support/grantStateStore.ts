import {
  createInMemoryPersistenceStore,
  createMinimalState,
} from '../contract/controlSurface/controlSurfaceHttpServer.sessionStreaming.testUtils'

/** Persisted state with one project that owns the given terminal nodes, for grant scope checks. */
export async function grantStateStore(projectId: string, nodeIds: readonly string[]) {
  const store = createInMemoryPersistenceStore()
  const state = createMinimalState('/repo', projectId, 'space')
  Object.assign(state.workspaces[0], {
    nodes: nodeIds.map(id => ({
      id,
      sessionId: `session-${id}`,
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
    })),
  })
  await store.writeAppState(state)
  return store
}

const terminalNode = (id: string, sessionId: string) => ({
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

/** Projects `project-a` (node n-a) and `project-b` (node n-b), each with a terminal node and session. */
export async function twoProjectGrantStore(paths: { a: string; b: string } = { a: '/a', b: '/b' }) {
  const store = createInMemoryPersistenceStore()
  const state = createMinimalState(paths.a, 'project-a', 's-a')
  const other = createMinimalState(paths.b, 'project-b', 's-b').workspaces[0]
  Object.assign(state.workspaces[0], { nodes: [terminalNode('n-a', 'sess-a')] })
  Object.assign(other, { nodes: [terminalNode('n-b', 'sess-b')] })
  state.workspaces.push(other)
  await store.writeAppState(state)
  return store
}

export const grantContext = (projectId: string) => ({
  now: () => new Date(),
  requestAuth: {
    kind: 'session-grant' as const,
    grant: {
      projectId,
      spaceId: 's-a',
      nodeId: 'n-a',
      sessionId: 'sess-a',
      grantId: 'g',
      tier: 'interact' as const,
      createdAt: '',
    },
  },
})
