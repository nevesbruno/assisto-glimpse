import { createExecutorLink, OrchestrationError, type AgentLink } from '../domain/agentLink'
import type { OrchestrationPrincipal } from '../domain/orchestrationAuthorization'
import type { OrchestrationSpawnResult } from '../../../shared/contracts/dto/orchestration'
import { acceptDispatch, acceptedOf } from './dispatchToExecutor'
import { closeExecutorLink, updateLink } from './linkLifecycle'
import type { OrchestrationContext } from './OrchestrationService'
import type { ExecutorRuntimeProvider } from './ports'
import { currentAdmission } from './statusView'

export interface SpawnInput {
  readonly requestId: string
  readonly provider: ExecutorRuntimeProvider
  readonly prompt?: string
  readonly title?: string
  readonly model?: string
  /** Only the user chooses it; an agent is always its own orchestrator. */
  readonly orchestratorNodeId?: string
}

export interface ServiceStart {
  readonly link: AgentLink
  readonly cwd: string
  readonly model: string | null
  readonly version: string
}

function asOrchestrationError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'executor.protocol_mismatch') {
    return new OrchestrationError('orch.protocol_mismatch')
  }
  return typeof code === 'string' && code.startsWith('executor.')
    ? new OrchestrationError('orch.executor_unavailable')
    : error
}

/** Starts the service of a link, resumes the session and marks the executor ready. */
export async function startExecutorService(
  ctx: OrchestrationContext,
  start: ServiceStart,
): Promise<void> {
  const { link } = start
  const slot = ctx.slotOf(link.executorNodeId)
  ctx.onRuntimeEvent(slot, { type: 'service.starting' })
  const runtime = await ctx.deps.runtimeFactory(link.provider as ExecutorRuntimeProvider).start({
    executorNodeId: link.executorNodeId,
    provider: link.provider as ExecutorRuntimeProvider,
    cwd: start.cwd,
    env: {},
    sessionRef: link.executorSessionRef,
    model: start.model,
    policy: { approvals: 'user', sandbox: null },
  })
  slot.runtime = runtime
  slot.unsubscribe = runtime.subscribe(event => ctx.onRuntimeEvent(slot, event))
  const session = await runtime.ensureSession({
    resumeRef: link.executorSessionRef,
    fresh: false,
  })
  if (session.sessionRef !== link.executorSessionRef) {
    await updateLink(ctx, link.id, current => ({
      ...current,
      executorSessionRef: session.sessionRef,
    }))
  }
  ctx.onRuntimeEvent(slot, {
    type: 'executor.ready',
    sessionRef: session.sessionRef,
    resumed: session.resumed,
    version: start.version,
  })
}

/** Starts again the service of an existing link, for boot and for the hooks restart. */
export async function restartLinkedService(
  ctx: OrchestrationContext,
  link: AgentLink,
): Promise<void> {
  const node = await ctx.deps.nodes.findNode(link.executorNodeId)
  if (!node?.cwd) {
    throw new OrchestrationError('orch.executor_unavailable')
  }
  const probe = await ctx.deps.runtimeFactory(link.provider as ExecutorRuntimeProvider).probe()
  if (!probe.compatible) {
    throw new OrchestrationError('orch.protocol_mismatch')
  }
  await startExecutorService(ctx, { link, cwd: node.cwd, version: probe.version, model: null })
}

async function existingSpawn(
  ctx: OrchestrationContext,
  link: AgentLink,
  requestId: string,
): Promise<OrchestrationSpawnResult> {
  const first = await ctx.deps.dispatches.findById(ctx.deps.ids.uuidV5(requestId))
  return {
    executorNodeId: link.executorNodeId,
    linkId: link.id,
    runtimeMode: link.runtimeMode,
    duplicate: true,
    dispatch: first ? acceptedOf(first, link) : null,
    admission: await currentAdmission(ctx, link),
  }
}

async function createLinkedExecutor(
  ctx: OrchestrationContext,
  orchestratorNodeId: string,
  input: SpawnInput,
) {
  const { nodes, links, ids, clock } = ctx.deps
  const factory = ctx.deps.runtimeFactory(input.provider)
  const probe = await factory.probe().catch((error: unknown) => {
    throw asOrchestrationError(error)
  })
  if (!probe.compatible) {
    throw new OrchestrationError('orch.protocol_mismatch')
  }
  const orchestrator = await nodes.findNode(orchestratorNodeId)
  if (!orchestrator) {
    throw new OrchestrationError('orch.link_invalid', 'orchestrator node not found')
  }
  const created = await nodes.createExecutorNode({
    orchestratorNodeId,
    provider: input.provider,
    title: input.title ?? null,
    model: input.model ?? null,
  })
  const executor = await nodes.findNode(created.nodeId)
  if (!executor?.cwd) {
    throw new OrchestrationError('orch.link_invalid', 'executor node has no working directory')
  }
  const link = createExecutorLink({
    id: ids.uuid(),
    spaceId: created.spaceId,
    orchestrator: orchestrator,
    executor: {
      nodeId: executor.nodeId,
      projectId: executor.projectId,
      provider: executor.provider,
    },
    spawnRequestId: input.requestId,
    existingLinks: await links.listActive(),
    now: clock.now(),
  })
  const inserted = await links.insert(link)
  if (!inserted.ok) {
    throw new OrchestrationError('orch.link_invalid', inserted.reason)
  }
  return { link: inserted.value, cwd: executor.cwd, version: probe.version }
}

async function launchTui(ctx: OrchestrationContext, executorNodeId: string): Promise<void> {
  const attach = await ctx.slotOf(executorNodeId).runtime!.attachInfo()
  await ctx.deps.tui.launch({ executorNodeId, attach })
}

export async function spawnExecutor(
  ctx: OrchestrationContext,
  principal: OrchestrationPrincipal,
  input: SpawnInput,
): Promise<OrchestrationSpawnResult> {
  await ctx.authorize(principal, 'orch.spawn', null)
  const orchestratorNodeId =
    principal.kind === 'agent' ? principal.nodeId : input.orchestratorNodeId
  if (!orchestratorNodeId) {
    throw new OrchestrationError('orch.link_invalid', 'orchestratorNodeId is required')
  }
  return ctx.runExclusive(`spawn:${orchestratorNodeId}`, async () => {
    const known = await ctx.deps.links.findBySpawnRequest(orchestratorNodeId, input.requestId)
    if (known) {
      return existingSpawn(ctx, known, input.requestId)
    }
    const { link, cwd, version } = await createLinkedExecutor(ctx, orchestratorNodeId, input)
    return ctx.runExclusive(link.executorNodeId, async () => {
      try {
        await startExecutorService(ctx, { link, cwd, version, model: input.model ?? null })
        await launchTui(ctx, link.executorNodeId)
      } catch (error) {
        await closeExecutorLink(ctx, link, 'spawn_failed', true)
        throw asOrchestrationError(error)
      }
      const current = (await ctx.deps.links.findById(link.id)) ?? link
      const first = input.prompt
        ? await acceptDispatch(ctx, {
            dispatchId: ctx.deps.ids.uuidV5(input.requestId),
            link: current,
            text: input.prompt,
          })
        : null
      const latest = (await ctx.deps.links.findById(link.id)) ?? current
      return {
        executorNodeId: link.executorNodeId,
        linkId: link.id,
        runtimeMode: link.runtimeMode,
        duplicate: false,
        dispatch: first && {
          dispatchId: first.dispatchId,
          state: first.state,
          round: first.round,
          roundsLimit: first.roundsLimit,
        },
        admission: first?.admission ?? (await currentAdmission(ctx, latest)),
      }
    })
  })
}
