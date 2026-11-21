import {
  taskClaimOperation,
  taskReleaseOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/task'
import { noteAppendOperation } from '../../../../shared/contracts/controlSurface/operations/domains/note'
import { installAgentSpawnOwner } from '../agentSpawnContext'
import { canvasFocusOperation } from '../../../../shared/contracts/controlSurface/operations/domains/canvas'
import { registerOperation } from '../registerOperation'
import {
  nodeManagedClaudeBindingOperation,
  nodeResolveCallerSelectorOperation,
  nodeCreateOperation,
  nodeListOperation,
  nodeGetOperation,
  nodeUpdateOperation,
  nodeDeleteOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/node'
import type { ControlSurface } from '../controlSurface'
import type { ControlSurfaceContext } from '../types'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import type {
  CanvasFocusResult,
  ListGitWorktreesResult,
  SyncEventPayload,
} from '../../../../shared/contracts/dto'
import { createAppError } from '../../../../shared/errors/appError'
import type { WorkerTopologyStore } from '../topology/topologyStore'
import {
  claimTask,
  releaseTask,
  appendNote,
  AgentSpawnAdmissionOwner,
  type AgentSpawnRuntimePort,
  resolveCallerParent,
  createNodeForNodeControl,
  getNodeForNodeControl,
  listNodesForNodeControl,
  updateNodeForNodeControl,
  deleteNodeForNodeControl,
  resolveCanvasFocusTargetForNodeControl,
  type SpaceLocatorResolverDeps,
  type NodeControlAppStateStore,
} from '../../../../contexts/workspace/application'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import { createRuntimeDeps } from './nodeControlRuntime'
import { grantProjectOf, isNodeInGrantLineage, isNodeInGrantSubtree } from './grantProjectScope'

async function invokeInternal<TResult>(
  controlSurface: ControlSurface,
  ctx: ControlSurfaceContext,
  request: { kind: 'query' | 'command'; id: string; payload: unknown },
): Promise<TResult> {
  const result = await controlSurface.invoke(ctx, request)
  if (!result.ok) {
    throw createAppError(result.error)
  }
  return result.value as TResult
}

function createLocatorDeps(
  controlSurface: ControlSurface,
  topology: WorkerTopologyStore,
  ctx: ControlSurfaceContext,
): SpaceLocatorResolverDeps {
  return {
    listEndpoints: async () => (await topology.listEndpoints()).endpoints,
    listMounts: async projectId => (await topology.listMounts({ projectId })).mounts,
    listWorktreesForMount: async mountId =>
      (
        await invokeInternal<ListGitWorktreesResult>(controlSurface, ctx, {
          kind: 'query',
          id: 'gitWorktree.listWorktreesInMount',
          payload: { mountId },
        })
      ).worktrees,
    listWorktreesForWorkspace: async workspace =>
      (
        await invokeInternal<ListGitWorktreesResult>(controlSurface, ctx, {
          kind: 'query',
          id: 'gitWorktree.listWorktrees',
          payload: { repoPath: workspace.path },
        })
      ).worktrees,
  }
}

function toNodeControlStateStore(store: PersistenceStore): NodeControlAppStateStore {
  return {
    nodeLineage: store.nodeLineage,
    commitCreatedNodeState: store.commitCreatedNodeState,
    readAppState: async () => normalizePersistedAppState(await store.readAppState()),
    isAppStateRevisionCurrent: store.isAppStateRevisionCurrent,
    readAppStateRevision: store.readAppStateRevision,
    writeAppState: store.writeAppState,
    isRuntimeReferenced: store.isManagedClaudeRuntimeReferenced,
    isManagedNode: store.observeManagedClaudeNode
      ? id => Boolean(store.observeManagedClaudeNode!(id).binding)
      : undefined,
  }
}

/** Unscoped only inside the grant's own lineage subtree; a foreign stranger stays absent. */
async function nodeProjectScopeForGrant(
  ctx: ControlSurfaceContext,
  store: NodeControlAppStateStore,
  nodeId: string,
  getPersistenceStore: () => Promise<PersistenceStore>,
): Promise<string | undefined> {
  const scope = grantProjectOf(ctx)
  if (scope === undefined) {
    return undefined
  }
  const state = await store.readAppState()
  const owner = state?.workspaces.find(workspace =>
    workspace.nodes.some(node => node.id === nodeId),
  )?.id
  if (owner === undefined || owner === scope) {
    return scope
  }
  return (await isNodeInGrantLineage(ctx, getPersistenceStore, nodeId)) ? undefined : scope
}

function queued<T>(queueRef: { current: Promise<void> }, task: () => Promise<T>): Promise<T> {
  const next = queueRef.current.then(task, task)
  queueRef.current = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export function registerNodeControlHandlers(
  controlSurface: ControlSurface,
  deps: {
    agentSpawnRuntime?: AgentSpawnRuntimePort
    killExactSession?: (sessionId: string) => void | Promise<void>
    topology: WorkerTopologyStore
    getPersistenceStore: () => Promise<PersistenceStore>
    publishSyncEvent?: (payload: SyncEventPayload) => number
    closePluginNode?: (nodeId: string) => Promise<void> | void
    closeWebsiteNode?: (nodeId: string) => Promise<void> | void
  },
): void {
  const admission =
    deps.agentSpawnRuntime && deps.killExactSession
      ? new AgentSpawnAdmissionOwner(deps.agentSpawnRuntime)
      : undefined
  if (admission) {
    installAgentSpawnOwner(controlSurface, admission, async () =>
      toNodeControlStateStore(await deps.getPersistenceStore()),
    )
  }
  const mutationQueue = { current: Promise.resolve() }
  const withDeps = async (ctx: ControlSurfaceContext) => ({
    store: toNodeControlStateStore(await deps.getPersistenceStore()),
    locatorDeps: createLocatorDeps(controlSurface, deps.topology, ctx),
    runtime: createRuntimeDeps(
      controlSurface,
      ctx,
      deps.closeWebsiteNode,
      deps.closePluginNode,
      admission,
      deps.killExactSession,
    ),
  })

  registerOperation(controlSurface, taskClaimOperation, {
    defaultErrorCode: 'persistence.io_failed',
    handle: async (ctx, input) =>
      claimTask({
        store: toNodeControlStateStore(await deps.getPersistenceStore()),
        input,
        now: ctx.now(),
        authority: ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant : undefined,
        assertActive: ctx.assertActive,
      }),
  })
  registerOperation(controlSurface, taskReleaseOperation, {
    defaultErrorCode: 'persistence.io_failed',
    handle: async (ctx, input) =>
      releaseTask({
        store: toNodeControlStateStore(await deps.getPersistenceStore()),
        input,
        now: ctx.now(),
        authority: ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant : undefined,
        assertActive: ctx.assertActive,
      }),
  })
  registerOperation(controlSurface, noteAppendOperation, {
    defaultErrorCode: 'persistence.io_failed',
    handle: async (ctx, input) =>
      appendNote({
        store: toNodeControlStateStore(await deps.getPersistenceStore()),
        input,
        authority: ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant : undefined,
        assertActive: ctx.assertActive,
      }),
  })
  registerOperation(controlSurface, nodeManagedClaudeBindingOperation, {
    defaultErrorCode: 'persistence.unavailable',
    handle: async (ctx, input) => {
      const store = await deps.getPersistenceStore()
      const controlStore = toNodeControlStateStore(store)
      const scope = grantProjectOf(ctx)
      if (scope !== undefined) {
        const state = await controlStore.readAppState()
        const owner = state?.workspaces.find(workspace =>
          workspace.nodes.some(node => node.id === input.nodeId),
        )?.id
        if (
          owner !== scope &&
          !(await isNodeInGrantLineage(ctx, deps.getPersistenceStore, input.nodeId))
        ) {
          // Same scope as node.get: a foreign target outside the subtree stays absent and
          // the binding is never read.
          throw createAppError('node.not_found')
        }
      }
      if (!store.observeManagedClaudeNode) {
        throw createAppError('persistence.unavailable')
      }
      const observed = store.observeManagedClaudeNode(input.nodeId)
      return {
        managedClaudeBinding: observed.binding,
        nodeRuntimeSessionId: observed.nodeRuntimeSessionId ?? null,
        retired: observed.retired,
        executionDirectory: observed.context?.directory ?? null,
      }
    },
  })
  registerOperation(controlSurface, nodeResolveCallerSelectorOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) => {
      const caller = ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant.nodeId : null
      if (!caller) {
        throw createAppError('node.parent_unavailable', {
          details: { reason: 'caller_identity_required' },
        })
      }
      const store = toNodeControlStateStore(await deps.getPersistenceStore())
      const result = await resolveCallerParent(store, caller, input)
      ctx.assertActive?.()
      return result
    },
  })
  registerOperation(controlSurface, nodeListOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) => {
      const { store, locatorDeps } = await withDeps(ctx)
      const scope = grantProjectOf(ctx)
      const foreign =
        scope !== undefined && input.projectId !== undefined && input.projectId !== scope
      if (!foreign) {
        return await listNodesForNodeControl({ store, locatorDeps, input, projectScope: scope })
      }
      // Narrow lineage carve-out: a grant sees its own creator's children in another project,
      // never the project itself. Everything else reads as an empty listing.
      const empty = { projectId: input.projectId, spaceId: null, nodes: [] } as const
      if (!input.spawnedByNodeId) {
        return empty
      }
      if (!(await isNodeInGrantSubtree(ctx, deps.getPersistenceStore, input.spawnedByNodeId))) {
        return empty
      }
      return await listNodesForNodeControl({ store, locatorDeps, input, projectScope: undefined })
    },
  })
  registerOperation(controlSurface, nodeGetOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) => {
      const store = await deps.getPersistenceStore()
      const controlStore = toNodeControlStateStore(store)
      const result = await getNodeForNodeControl({
        store: controlStore,
        input,
        projectScope: await nodeProjectScopeForGrant(
          ctx,
          controlStore,
          input.nodeId,
          deps.getPersistenceStore,
        ),
      })
      const binding = store.observeManagedClaudeNode?.(input.nodeId).binding
      return { ...result, ...(binding ? { managedClaudeBinding: binding } : {}) }
    },
  })
  registerOperation(controlSurface, nodeCreateOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) =>
      queued(mutationQueue, async () => {
        ctx.assertActive?.()
        const { store, locatorDeps, runtime } = await withDeps(ctx)
        const scope = grantProjectOf(ctx)
        const grantNodeId =
          ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant.nodeId : null
        const foreignCreate =
          scope !== undefined && typeof input.projectId === 'string' && input.projectId !== scope
        if (foreignCreate && !grantNodeId) {
          throw createAppError('node.not_found')
        }
        if (foreignCreate && input.near) {
          const nearNodeId = input.near.nodeId
          if (!(await isNodeInGrantSubtree(ctx, deps.getPersistenceStore, nearNodeId))) {
            throw createAppError('node.not_found')
          }
        }
        return await createNodeForNodeControl({
          store,
          locatorDeps,
          runtime,
          input,
          // A foreign create is allowed only as a child of the caller; prepareNodeLineage
          // records the grant as creator, so the new node joins the lineage subtree.
          projectScope: foreignCreate ? undefined : scope,
          now: ctx.now(),
          admission,
          authority: ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant : undefined,
          callerNodeId:
            ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant.nodeId : null,
        })
      }),
  })
  registerOperation(controlSurface, nodeUpdateOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) =>
      queued(mutationQueue, async () => {
        const controlStore = toNodeControlStateStore(await deps.getPersistenceStore())
        return await updateNodeForNodeControl({
          store: controlStore,
          input,
          projectScope: await nodeProjectScopeForGrant(
            ctx,
            controlStore,
            input.nodeId,
            deps.getPersistenceStore,
          ),
          assertActive: ctx.assertActive,
        })
      }),
  })
  registerOperation(controlSurface, nodeDeleteOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) =>
      queued(mutationQueue, async () => {
        const runtime = createRuntimeDeps(
          controlSurface,
          ctx,
          deps.closeWebsiteNode,
          deps.closePluginNode,
          admission,
          deps.killExactSession,
        )
        return await deleteNodeForNodeControl({
          store: toNodeControlStateStore(await deps.getPersistenceStore()),
          runtime,
          input,
          projectScope: grantProjectOf(ctx),
          now: ctx.now(),
          assertActive: ctx.assertActive,
        })
      }),
  })
  registerOperation(controlSurface, canvasFocusOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) => {
      const persistenceStore = await deps.getPersistenceStore()
      const store = toNodeControlStateStore(persistenceStore)
      const locatorDeps = createLocatorDeps(controlSurface, deps.topology, ctx)
      const resolved = await resolveCanvasFocusTargetForNodeControl({
        store,
        locatorDeps,
        target: input.target,
        projectScope: grantProjectOf(ctx),
      })
      const payload: SyncEventPayload = {
        type: 'canvas.focus',
        revision: await persistenceStore.readAppStateRevision(),
        projectId: resolved.projectId,
        target: resolved.target,
        createdAt: ctx.now().toISOString(),
      }
      ctx.assertActive?.()
      const deliveredClientCount = deps.publishSyncEvent?.(payload) ?? 0
      return {
        projectId: resolved.projectId,
        target: resolved.target,
        deliveredClientCount,
        delivered: deliveredClientCount > 0,
      } satisfies CanvasFocusResult
    },
  })
}
