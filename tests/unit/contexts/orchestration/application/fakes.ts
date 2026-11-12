import { createHash } from 'node:crypto'
import {
  OrchestrationService,
  type OrchestrationDeps,
} from '../../../../../src/contexts/orchestration/application/OrchestrationService'
import type {
  CasResult,
  ExecutorRuntimeEvent,
  ExecutorStartSpec,
  HookApproval,
  InsertDispatchResult,
  InsertLinkResult,
  StoredNotice,
  UpdateDispatchResult,
} from '../../../../../src/contexts/orchestration/application/ports'
import type { AgentLink } from '../../../../../src/contexts/orchestration/domain/agentLink'
import { ORCHESTRATOR_PROVIDER } from '../../../../../src/contexts/orchestration/domain/agentLink'
import {
  isFinalDispatchState,
  isInFlightDispatchState,
  type Dispatch,
  type DispatchState,
} from '../../../../../src/contexts/orchestration/domain/dispatch'
import type { OrchestrationPrincipal } from '../../../../../src/contexts/orchestration/domain/orchestrationAuthorization'
import { InMemoryDispatchLedger } from './inMemoryDispatchLedger'
import { FakeRuntime } from './fakes.runtime'

export { FakeRuntime, sha256 } from './fakes.runtime'

export const ORCHESTRATOR = 'orq'
export const USER: OrchestrationPrincipal = { kind: 'user' }
export const orchestratorPrincipal = (nodeId = ORCHESTRATOR): OrchestrationPrincipal => ({
  kind: 'agent',
  nodeId,
  projectId: 'p1',
  spaceId: 's1',
  sessionId: `session-${nodeId}`,
  provider: ORCHESTRATOR_PROVIDER,
  grantActive: true,
})

export function uuidFrom(name: string): string {
  const hex = createHash('sha1').update(name).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class InMemoryLinks {
  public readonly rows = new Map<string, AgentLink>()
  public revision = 0

  public insert = async (link: AgentLink): Promise<InsertLinkResult> => {
    if (this.rows.has(link.id)) {
      return { ok: false, reason: 'id_exists' }
    }
    const rows = [...this.rows.values()]
    if (
      link.state === 'active' &&
      rows.some(r => r.state === 'active' && r.executorNodeId === link.executorNodeId)
    ) {
      return { ok: false, reason: 'executor_already_linked' }
    }
    if (
      link.spawnRequestId &&
      rows.some(
        r =>
          r.orchestratorNodeId === link.orchestratorNodeId &&
          r.spawnRequestId === link.spawnRequestId,
      )
    ) {
      return { ok: false, reason: 'spawn_request_duplicate' }
    }
    this.rows.set(link.id, link)
    this.revision += 1
    return { ok: true, value: link }
  }

  public update = async (next: AgentLink): Promise<CasResult<AgentLink>> => {
    const stored = this.rows.get(next.id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    if (next.revision !== stored.revision + 1) {
      return { ok: false, reason: 'revision_conflict' }
    }
    this.rows.set(next.id, next)
    this.revision += 1
    return { ok: true, value: next }
  }

  public findById = async (id: string) => this.rows.get(id) ?? null
  public findActiveByExecutor = async (nodeId: string) =>
    [...this.rows.values()].find(r => r.state === 'active' && r.executorNodeId === nodeId) ?? null
  public findBySpawnRequest = async (orq: string, requestId: string) =>
    [...this.rows.values()].find(
      r => r.orchestratorNodeId === orq && r.spawnRequestId === requestId,
    ) ?? null
  public listActiveByOrchestrator = async (orq: string) =>
    [...this.rows.values()].filter(r => r.state === 'active' && r.orchestratorNodeId === orq)
  public listActive = async () => [...this.rows.values()].filter(r => r.state === 'active')
  public listByProject = async (projectId: string | null) =>
    [...this.rows.values()].filter(r => projectId === null || r.projectId === projectId)
  public readLinksRevision = async () => this.revision

  public extendRounds = async (linkId: string, by: number, at: string) => {
    const stored = this.rows.get(linkId)
    if (!stored) {
      return null
    }
    const next = {
      ...stored,
      roundsLimit: stored.roundsLimit + by,
      revision: stored.revision + 1,
      updatedAt: at,
    }
    this.rows.set(linkId, next)
    this.revision += 1
    return next
  }
}

export class InMemoryDispatches {
  public readonly rows = new Map<string, Dispatch>()
  public insertCalls = 0

  private open(executorNodeId: string) {
    return [...this.rows.values()].find(
      d => d.executorNodeId === executorNodeId && !isFinalDispatchState(d.state),
    )
  }

  public insert = async (dispatch: Dispatch): Promise<InsertDispatchResult> => {
    this.insertCalls += 1
    if (this.rows.has(dispatch.id)) {
      return { ok: false, reason: 'id_exists' }
    }
    if (this.open(dispatch.executorNodeId)) {
      return { ok: false, reason: 'executor_busy' }
    }
    this.rows.set(dispatch.id, dispatch)
    return { ok: true, value: dispatch }
  }

  public hasOtherInFlight(next: Dispatch): boolean {
    return [...this.rows.values()].some(
      d =>
        d.executorNodeId === next.executorNodeId &&
        d.id !== next.id &&
        isInFlightDispatchState(d.state),
    )
  }

  public update = async (next: Dispatch): Promise<UpdateDispatchResult> => {
    if (next.state === 'reserved' && this.hasOtherInFlight(next)) {
      return { ok: false, reason: 'in_flight_conflict' }
    }
    const stored = this.rows.get(next.id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    if (next.revision !== stored.revision + 1) {
      return { ok: false, reason: 'revision_conflict' }
    }
    this.rows.set(next.id, next)
    return { ok: true, value: next }
  }

  public findById = async (id: string) => this.rows.get(id) ?? null
  public findInFlightByExecutor = async (nodeId: string) =>
    [...this.rows.values()].find(
      d => d.executorNodeId === nodeId && isInFlightDispatchState(d.state),
    ) ?? null
  public findOldestQueuedByExecutor = async (nodeId: string) =>
    [...this.rows.values()].find(d => d.executorNodeId === nodeId && d.state === 'queued') ?? null
  public listByLink = async (linkId: string) =>
    [...this.rows.values()].filter(d => d.linkId === linkId)
  public listByStates = async (states: readonly DispatchState[]) =>
    [...this.rows.values()].filter(d => states.includes(d.state))
  public findNonFinalByExecutor = async (nodeId: string) => this.open(nodeId) ?? null
}

export class InMemoryNotices {
  public readonly rows: StoredNotice[] = []
  public enqueue = async (notice: StoredNotice) => {
    if (this.rows.some(r => r.dedupeKey === notice.dedupeKey)) {
      return { enqueued: false as const }
    }
    this.rows.push(notice)
    return { enqueued: true as const }
  }
  public listPending = async (orq: string) =>
    this.rows.filter(r => r.orchestratorNodeId === orq && r.state === 'pending')
  public listUncertain = async (orq: string) =>
    this.rows.filter(r => r.orchestratorNodeId === orq && r.state === 'uncertain')
  public settleBatch = async () => {}
  public deleteByOrchestrator = async (orq: string) => {
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i].orchestratorNodeId === orq) {
        this.rows.splice(i, 1)
      }
    }
  }
}

export class InMemoryHookApprovals {
  public readonly rows: HookApproval[] = []
  public record = async (approvals: readonly HookApproval[]) => {
    for (const a of approvals) {
      if (!this.rows.some(r => r.key === a.key && r.currentHash === a.currentHash)) {
        this.rows.push(a)
      }
    }
  }
  public findApproved = async (pairs: readonly { key: string; currentHash: string }[]) =>
    this.rows.filter(r => pairs.some(p => p.key === r.key && p.currentHash === r.currentHash))
}

export interface FakeNode {
  nodeId: string
  provider: string
  title: string
  projectId?: string
}

export interface Harness {
  readonly service: OrchestrationService
  readonly links: InMemoryLinks
  readonly dispatches: InMemoryDispatches
  readonly notices: InMemoryNotices
  readonly hookApprovals: InMemoryHookApprovals
  readonly runtimes: Map<string, FakeRuntime>
  readonly runState: Record<string, unknown[][]>
  readonly tuiLaunches: string[]
  readonly tuiRelaunches: string[]
  readonly tuiRetired: string[]
  readonly published: number[]
  readonly starts: ExecutorStartSpec[]
  readonly failNextStart: { error: (Error & { code: string }) | null }
  readonly probe: { compatible: boolean }
  readonly clock: { current: Date; now: () => Date }
  readonly nodes: Map<string, FakeNode>
  readonly hooks: { onRuntimeStart: ((runtime: FakeRuntime) => void) | null }
  /** The app state the reconciler reads: `fail` is a read error, `noWorkspace` an empty state. */
  readonly appState: { fail: boolean; noWorkspace: boolean; stopped: boolean }
  /** A new Worker over the same stored rows, with no running service. */
  readonly restart: () => OrchestrationService
}

export function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

export function createHarness(
  options: {
    reapOrphanServices?: OrchestrationDeps['reapOrphanServices']
    tui?: OrchestrationDeps['tui']
  } = {},
): Harness {
  const links = new InMemoryLinks()
  const dispatches = new InMemoryDispatches()
  const notices = new InMemoryNotices()
  const hookApprovals = new InMemoryHookApprovals()
  const runtimes = new Map<string, FakeRuntime>()
  const starts: ExecutorStartSpec[] = []
  const tuiLaunches: string[] = []
  const tuiRelaunches: string[] = []
  const tuiRetired: string[] = []
  const published: number[] = []
  const failNextStart: Harness['failNextStart'] = { error: null }
  const probe = { compatible: true }
  const hooks: Harness['hooks'] = { onRuntimeStart: null }
  const appState: Harness['appState'] = { fail: false, noWorkspace: false, stopped: false }
  const clock = {
    current: new Date('2026-11-09T12:00:00.000Z'),
    now() {
      return this.current
    },
  }
  const runState: Harness['runState'] = {}
  const record = <T>(name: string, result: T) => {
    return async (...args: unknown[]): Promise<T> => {
      ;(runState[name] ??= []).push(args)
      return result
    }
  }
  const nodes = new Map<string, FakeNode>()
  nodes.set(ORCHESTRATOR, { nodeId: ORCHESTRATOR, provider: ORCHESTRATOR_PROVIDER, title: 'orq' })
  let nodeCounter = 0
  let idCounter = 0
  const deps: OrchestrationDeps = {
    links,
    dispatches,
    ledger: new InMemoryDispatchLedger(links, dispatches, notices),
    notices,
    hookApprovals,
    clock,
    ids: {
      uuid: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`,
      uuidV5: uuidFrom,
    },
    nodes: {
      createExecutorNode: async input => {
        nodeCounter += 1
        const nodeId = `exec-${nodeCounter}`
        nodes.set(nodeId, { nodeId, provider: input.provider, title: input.title ?? nodeId })
        return { nodeId, spaceId: 's1' }
      },
      findNode: async nodeId => {
        const node = nodes.get(nodeId)
        return node
          ? {
              ...node,
              projectId: node.projectId ?? 'p1',
              spaceId: 's1',
              cwd: node.provider === ORCHESTRATOR_PROVIDER ? null : '/work',
            }
          : null
      },
    },
    tui: options.tui ?? {
      launch: async input => {
        tuiLaunches.push(input.executorNodeId)
      },
      relaunch: async input => {
        tuiLaunches.push(input.executorNodeId)
        tuiRelaunches.push(input.executorNodeId)
      },
      retire: nodeId => {
        tuiRetired.push(nodeId)
      },
    },
    runState: {
      recordTurnStarted: async (...args) => {
        ;(runState.recordTurnStarted ??= []).push(args)
        return { glimpseTurnId: `glimpse-${++idCounter}` }
      },
      recordTurnCompleted: record('recordTurnCompleted', undefined),
      recordWaitingForApproval: record('recordWaitingForApproval', undefined),
      recordApprovalResolved: record('recordApprovalResolved', undefined),
      recordExecutorDown: record('recordExecutorDown', undefined),
      recordExecutorRecovered: record('recordExecutorRecovered', undefined),
    },
    events: { publishLinksUpdated: event => published.push(event.linksRevision) },
    runtimeFactory: () => ({
      probe: async () => ({
        executablePath: '/bin/codex',
        version: '0.170.0',
        compatible: probe.compatible,
      }),
      start: async spec => {
        starts.push(spec)
        if (failNextStart.error) {
          const error = failNextStart.error
          failNextStart.error = null
          throw error
        }
        const runtime = new FakeRuntime(spec)
        runtimes.set(spec.executorNodeId, runtime)
        hooks.onRuntimeStart?.(runtime)
        return runtime
      },
    }),
    reapOrphanServices: options.reapOrphanServices,
    readLiveNodeIds: async () => {
      if (appState.fail) {
        throw new Error('state read failed')
      }
      return appState.noWorkspace ? null : new Set(nodes.keys())
    },
    isStopped: () => appState.stopped,
  }
  return {
    service: new OrchestrationService(deps),
    links,
    dispatches,
    notices,
    hookApprovals,
    runtimes,
    runState,
    tuiLaunches,
    tuiRelaunches,
    tuiRetired,
    published,
    starts,
    failNextStart,
    probe,
    clock,
    nodes,
    hooks,
    appState,
    restart: () => {
      runtimes.clear()
      return new OrchestrationService(deps)
    },
  }
}

export async function bootedHarness(
  options?: Parameters<typeof createHarness>[0],
): Promise<Harness> {
  const harness = createHarness(options)
  await harness.service.finishBoot()
  return harness
}

export const SPAWN_REQUEST_ID = '11111111-1111-4111-8111-111111111111'

export async function spawnedHarness(prompt?: string) {
  const harness = await bootedHarness()
  const result = await harness.service.spawn(orchestratorPrincipal(), {
    requestId: SPAWN_REQUEST_ID,
    provider: 'codex',
    ...(prompt ? { prompt } : {}),
  })
  await harness.service.whenIdle()
  const runtime = harness.runtimes.get(result.executorNodeId)!
  return { harness, result, executorNodeId: result.executorNodeId, linkId: result.linkId, runtime }
}

export const readyEvent: ExecutorRuntimeEvent = {
  type: 'executor.ready',
  sessionRef: 's',
  resumed: false,
  version: '1',
}

export function completedEvent(
  turnRef: string,
  dispatchId: string | null,
  outcome: 'completed' | 'failed' | 'interrupted' = 'completed',
  finalMessage: string | null = 'done',
): ExecutorRuntimeEvent {
  return { type: 'turn.completed', turnRef, dispatchId, outcome, finalMessage, usage: null }
}

export function startedEvent(
  turnRef: string,
  dispatchId: string | null,
  origin: 'glimpse' | 'screen' = 'glimpse',
): ExecutorRuntimeEvent {
  return { type: 'turn.started', turnRef, dispatchId, origin }
}
