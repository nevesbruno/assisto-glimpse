import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  CreatedExecutorNode,
  ExecutorNodeInfo,
  ExecutorNodePort,
  ExecutorRuntimeFactory,
  ExecutorRuntimeProvider,
  HookKeyHash,
  IdGenerator,
} from '../../../../contexts/orchestration/application/ports'
import {
  createCodexExecutorRuntimeFactory,
  type CodexFactoryDeps,
} from '../../../../contexts/orchestration/infrastructure/codex/CodexExecutorRuntimeFactory'
import { startCodexAppServer } from '../../../../contexts/orchestration/infrastructure/codex/CodexAppServerProcess'
import { CodexJsonRpcClient } from '../../../../contexts/orchestration/infrastructure/codex/CodexJsonRpcClient'
import type { SqliteHandle } from '../../../../contexts/orchestration/infrastructure/persistence/sqliteHandle'
import { resolveAgentExecutable } from '../../../../contexts/agent/infrastructure/cli/AgentExecutableResolver'
import { normalizeAgentSettings } from '../../../../contexts/settings/domain/agentSettings'
import { createNodeForNodeControl } from '../../../../contexts/workspace/application/nodeControl/nodeControlUseCases'
import type {
  NodeControlAppState,
  NodeControlAppStateStore,
} from '../../../../contexts/workspace/application/nodeControl/nodeControlState'
import type { SpaceLocatorResolverDeps } from '../../../../contexts/workspace/application/nodeControl/spaceLocator'
import { resolveCanonicalNodeSize } from '../../../../contexts/workspace/domain/workspaceNodeSizing'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import { nodeWorkerBindingForMount } from '../../../../shared/types/nodeWorkerBinding'
import { reserveLoopbackPort } from '../handlers/sessionLaunchSupport'
import type { WorkerTopologyStore } from '../topology/topologyStore'
import { placeExecutorNode } from './executorNodePlacement'
import type { LiveExecutorSession } from './executorRunStateAdapter'

const run = promisify(execFile)

export type CodexFactoryOverrides = Pick<
  CodexFactoryDeps,
  'startProcess' | 'createClient' | 'resolveExecutable'
>

export const realCodexOverrides: CodexFactoryOverrides = {
  startProcess: input =>
    startCodexAppServer(input, { reserveLoopbackPort: () => reserveLoopbackPort('127.0.0.1') }),
  createClient: target => new CodexJsonRpcClient(target),
  resolveExecutable: async () => {
    const located = await resolveAgentExecutable({ provider: 'codex' })
    if (!located.executablePath) {
      throw Object.assign(new Error('codex executable not found'), {
        code: 'executor.start_failed' as const,
      })
    }
    const { stdout } = await run(located.executablePath, ['--version'])
    return { executablePath: located.executablePath, version: stdout.trim() }
  },
}

export function createIdGenerator(): IdGenerator {
  return {
    uuid: () => randomUUID(),
    uuidV5: name => {
      const bytes = createHash('sha1').update(NAMESPACE).update(name).digest().subarray(0, 16)
      bytes[6] = (bytes[6] & 0x0f) | 0x50
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = bytes.toString('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    },
  }
}
const NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')

export function readApprovedHooks(db: SqliteHandle): () => Promise<readonly HookKeyHash[]> {
  return async () =>
    db
      .prepare('SELECT hook_key, current_hash FROM orchestration_hook_approvals')
      .all()
      .map(row => {
        const { hook_key: key, current_hash: currentHash } = row as {
          hook_key: string
          current_hash: string
        }
        return { key, currentHash }
      })
}

async function readState(store: PersistenceStore): Promise<NodeControlAppState> {
  const state = normalizePersistedAppState(await store.readAppState())
  if (!state) {
    throw new Error('Missing persisted app state.')
  }
  return state as unknown as NodeControlAppState
}

/** The full access option is read when a service starts, because the factory reads it synchronously. */
export function createRuntimeFactory(input: {
  provider: ExecutorRuntimeProvider
  overrides: CodexFactoryOverrides
  approvedHooks: CodexFactoryDeps['approvedHooks']
  getPersistenceStore: () => Promise<PersistenceStore>
  createCodexFactory?: typeof createCodexExecutorRuntimeFactory
}): ExecutorRuntimeFactory {
  if (input.provider !== 'codex') {
    const unavailable = (): never => {
      throw Object.assign(new Error(`${input.provider} executor is not available`), {
        code: 'executor.start_failed' as const,
      })
    }
    return { probe: async () => unavailable(), start: async () => unavailable() }
  }
  const create = input.createCodexFactory ?? createCodexExecutorRuntimeFactory
  const build = (fullAccess: boolean) =>
    create({
      ...input.overrides,
      approvedHooks: input.approvedHooks,
      readFullAccess: () => fullAccess,
    })
  return {
    probe: () => build(false).probe(),
    start: async spec => {
      const state = normalizePersistedAppState(
        await (await input.getPersistenceStore()).readAppState(),
      )
      return build(normalizeAgentSettings(state?.settings).agentFullAccess).start(spec)
    },
  }
}

/** Session of the TUI of each executor node: the source of `liveSessionOf` and `bindSession`. */
export function createLiveSessions(deps: {
  getPersistenceStore: () => Promise<PersistenceStore>
  onExit: (listener: (event: { sessionId: string }) => void) => () => void
}) {
  const live = new Map<string, LiveExecutorSession>()
  const stopWatching = deps.onExit(({ sessionId }) => {
    for (const [nodeId, session] of live) {
      if (session.sessionId === sessionId) {
        live.delete(nodeId)
      }
    }
  })
  return {
    liveSessionOf: (nodeId: string): LiveExecutorSession | null => live.get(nodeId) ?? null,
    bindSession: async (nodeId: string, sessionId: string): Promise<void> => {
      const store = await deps.getPersistenceStore()
      const expectedRevision = await store.readAppStateRevision()
      const state = await readState(store)
      const node = state.workspaces.flatMap(workspace => workspace.nodes).find(n => n.id === nodeId)
      if (!node) {
        throw new Error(`Executor node ${nodeId} not found.`)
      }
      node.sessionId = sessionId
      const written = await store.writeAppState(state, { expectedRevision })
      if (!written.ok) {
        throw new Error(`Binding the TUI session to ${nodeId} failed: ${written.reason}`)
      }
      live.set(nodeId, { sessionId, provider: 'codex', incarnation: randomUUID() })
    },
    dispose: stopWatching,
  }
}

function toNodeStore(store: PersistenceStore): NodeControlAppStateStore {
  return {
    readAppState: async () => await readState(store),
    readAppStateRevision: store.readAppStateRevision,
    writeAppState: store.writeAppState,
  }
}

const notNeeded = async (): Promise<never> => {
  throw new Error('Not needed to place an executor node by space id.')
}

/** Node ids of the stored state; null when it has no workspace, so an empty state closes nothing. */
export function createLiveNodeIdsReader(
  getPersistenceStore: () => Promise<PersistenceStore>,
): () => Promise<ReadonlySet<string> | null> {
  return async () => {
    const { workspaces } = await readState(await getPersistenceStore())
    return workspaces.length === 0
      ? null
      : new Set(workspaces.flatMap(workspace => workspace.nodes.map(node => node.id)))
  }
}

export function createExecutorNodePort(deps: {
  getPersistenceStore: () => Promise<PersistenceStore>
  topology: Pick<WorkerTopologyStore, 'listEndpoints' | 'listMounts'>
  now: () => Date
}): ExecutorNodePort {
  const locatorDeps: SpaceLocatorResolverDeps = {
    listEndpoints: async () => (await deps.topology.listEndpoints()).endpoints,
    listMounts: async projectId => (await deps.topology.listMounts({ projectId })).mounts,
    listWorktreesForMount: notNeeded,
    listWorktreesForWorkspace: notNeeded,
  }
  return {
    findNode: async (nodeId): Promise<ExecutorNodeInfo | null> => {
      const state = await readState(await deps.getPersistenceStore())
      for (const workspace of state.workspaces) {
        const node = workspace.nodes.find(n => n.id === nodeId)
        if (node) {
          const agent = node.agent as { provider?: string } | null
          return {
            nodeId,
            projectId: workspace.id,
            spaceId: workspace.spaces.find(s => s.nodeIds.includes(nodeId))?.id ?? '',
            provider: agent?.provider ?? '',
            title: node.title,
            cwd: node.executionDirectory ?? null,
          }
        }
      }
      return null
    },
    createExecutorNode: async (input): Promise<CreatedExecutorNode> => {
      const store = await deps.getPersistenceStore()
      const state = await readState(store)
      const workspace = state.workspaces.find(w =>
        w.nodes.some(n => n.id === input.orchestratorNodeId),
      )
      const orchestrator = workspace?.nodes.find(n => n.id === input.orchestratorNodeId)
      const space = workspace?.spaces.find(s => s.nodeIds.includes(input.orchestratorNodeId))
      if (!workspace || !orchestrator || !space) {
        throw new Error(`Orchestrator node ${input.orchestratorNodeId} not found.`)
      }
      const size = resolveCanonicalNodeSize({
        kind: 'agent',
        bucket: normalizeAgentSettings(state.settings).standardWindowSizeBucket,
      })
      const rectOf = (n: typeof orchestrator) => ({
        x: n.position.x,
        y: n.position.y,
        width: n.width,
        height: n.height,
      })
      const position = placeExecutorNode({
        orchestrator: rectOf(orchestrator),
        others: workspace.nodes.map(rectOf),
        size,
      })
      const created = await createNodeForNodeControl({
        store: toNodeStore(store),
        locatorDeps,
        now: deps.now(),
        input: {
          kind: 'agent',
          projectId: workspace.id,
          space: { kind: 'spaceId', spaceId: space.id },
          title: input.title,
          frame: { ...position, ...size },
          data: { provider: input.provider, prompt: '', model: input.model },
        },
        runtime: {
          launchAgent: async (resolved, data) => ({
            sessionId: '',
            provider: input.provider,
            prompt: '',
            model: data.model,
            effectiveModel: null,
            resumeSessionId: null,
            executionDirectory: resolved.workingDirectory,
            expectedDirectory: resolved.workingDirectory,
            startedAt: deps.now().toISOString(),
            workerBinding: nodeWorkerBindingForMount(resolved.mount),
          }),
          spawnTerminal: notNeeded,
          killSession: () => undefined,
        },
      })
      return { nodeId: created.node.id, spaceId: space.id }
    },
  }
}
