import Database from 'better-sqlite3'
import { OrchestrationService } from '../../../../contexts/orchestration/application/OrchestrationService'
import type { ExecutorRuntimeProvider } from '../../../../contexts/orchestration/application/ports'
import { SqliteAgentLinkRepository } from '../../../../contexts/orchestration/infrastructure/persistence/SqliteAgentLinkRepository'
import { SqliteDispatchLedger } from '../../../../contexts/orchestration/infrastructure/persistence/SqliteDispatchLedger'
import { SqliteDispatchRepository } from '../../../../contexts/orchestration/infrastructure/persistence/SqliteDispatchRepository'
import { SqliteHookApprovalRepository } from '../../../../contexts/orchestration/infrastructure/persistence/SqliteHookApprovalRepository'
import { SqliteNoticeOutboxRepository } from '../../../../contexts/orchestration/infrastructure/persistence/SqliteNoticeOutboxRepository'
import type { SqliteHandle } from '../../../../contexts/orchestration/infrastructure/persistence/sqliteHandle'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import type { PromptDeliveryService } from '../../../../contexts/agent/application/PromptDeliveryService'
import type { PtyStreamHub } from '../ptyStream/ptyStreamHub'
import type { ControlSurfacePtyRuntime } from '../handlers/sessionPtyRuntime'
import type { OrchestrationBackend } from '../handlers/orchestrationHandlers.support'
import { writeOrchestrationLinksMirror } from '../../../../platform/persistence/sqlite/write'
import type { WorkerTopologyStore } from '../topology/topologyStore'
import {
  createExecutorNodePort,
  createIdGenerator,
  createLiveNodeIdsReader,
  createLiveSessions,
  createRuntimeFactory,
  readApprovedHooks,
  realCodexOverrides,
  type CodexFactoryOverrides,
} from './composeOrchestrationDeps'
import {
  createExecutorRunStateAdapter,
  type ExecutorRunStateAdapterDeps,
} from './executorRunStateAdapter'
import {
  createOrchestrationEvents,
  type OrchestrationEventSources,
} from './composeOrchestrationEvents'
import { createCodexOrphanReaper } from '../../../../contexts/orchestration/infrastructure/codex/CodexOrphanReaper'
import { createOrchestrationBoot } from './composeOrchestrationBoot'
import { createExecutorTuiLauncher } from './executorTuiLauncher'

export const ORCHESTRATION_BUSY_TIMEOUT_MS = 5000

export interface OrchestrationConnection extends SqliteHandle {
  close: () => void
}

export interface ComposeOrchestrationInput {
  /** Own connection of the service: the PersistenceStore writer never sees its transactions. */
  openDatabase: () => OrchestrationConnection
  getPersistenceStore: () => Promise<PersistenceStore>
  topology: Pick<WorkerTopologyStore, 'listEndpoints' | 'listMounts'>
  ptyRuntime: Pick<ControlSurfacePtyRuntime, 'spawnSession' | 'kill' | 'onExit'>
  registry: ExecutorRunStateAdapterDeps['registry']
  schedule: ExecutorRunStateAdapterDeps['schedule']
  log: ExecutorRunStateAdapterDeps['log']
  /** Without it the service runs with no notices, no mirror and no health publication. */
  events?: OrchestrationEventSources
  codex?: CodexFactoryOverrides
  /** Seam of the tests: replaces the real Codex factory. */
  createCodexFactory?: Parameters<typeof createRuntimeFactory>[0]['createCodexFactory']
  now?: () => Date
}

export interface ComposedOrchestration extends OrchestrationBackend {
  /** Session of the TUI alive after the relaunch, or null without an active service link. */
  reviveExecutorTui: (nodeId: string) => Promise<string | null>
  /** Closes the links of nodes that left the stored state; runs after every state write. */
  reconcileDeletedNodes: () => Promise<void>
  /** Reconciles, publishes the mirror and relaunches the TUIs; never rejects. */
  boot: () => Promise<void>
  /** Stops events, then the services, then closes the connection. */
  dispose: () => Promise<void>
}

export function composeOrchestration(input: ComposeOrchestrationInput): ComposedOrchestration {
  const db = input.openDatabase()
  db.exec(`PRAGMA busy_timeout = ${ORCHESTRATION_BUSY_TIMEOUT_MS}`)
  const now = input.now ?? (() => new Date())
  const codex = input.codex ?? realCodexOverrides
  const sessions = createLiveSessions({
    getPersistenceStore: input.getPersistenceStore,
    onExit: input.ptyRuntime.onExit,
  })
  const runState = createExecutorRunStateAdapter({
    registry: input.registry,
    liveSessionOf: sessions.liveSessionOf,
    now: () => now().getTime(),
    schedule: input.schedule,
    log: input.log,
  })
  let stopped = false
  const links = new SqliteAgentLinkRepository(db)
  const hookApprovals = new SqliteHookApprovalRepository(db)
  const dispatches = new SqliteDispatchRepository(db)
  const notices = new SqliteNoticeOutboxRepository(db)
  const ids = createIdGenerator()
  const nodes = createExecutorNodePort({
    getPersistenceStore: input.getPersistenceStore,
    topology: input.topology,
    now,
  })
  const wiring =
    input.events &&
    createOrchestrationEvents({
      links,
      dispatches,
      notices,
      nodes,
      clock: { now },
      ids,
      schedule: input.schedule,
      log: input.log,
      writeMirror: mirror =>
        writeOrchestrationLinksMirror(db as unknown as Database.Database, mirror),
      readAppStateRevision: async () => (await input.getPersistenceStore()).readAppStateRevision(),
      sources: input.events,
    })
  const approvedHooks = readApprovedHooks(db)
  let codexPath: string | null = null
  const resolveExecutable: CodexFactoryOverrides['resolveExecutable'] = async () => {
    const resolved = await codex.resolveExecutable()
    codexPath = resolved.executablePath
    return resolved
  }
  const tui = createExecutorTuiLauncher({
    ptyRuntime: input.ptyRuntime,
    resolveCodexExecutable: () => {
      if (!codexPath) {
        throw new Error('The codex executable was not resolved before the TUI launch.')
      }
      return codexPath
    },
    liveSessionOf: nodeId => sessions.liveSessionOf(nodeId)?.sessionId ?? null,
    bindSession: sessions.bindSession,
  })
  const service = new OrchestrationService({
    links,
    dispatches,
    ledger: new SqliteDispatchLedger(db),
    notices,
    hookApprovals,
    clock: { now },
    ids,
    nodes,
    tui,
    runState,
    events: wiring?.events ?? { publishLinksUpdated: () => undefined },
    runtimeFactory: (provider: ExecutorRuntimeProvider) =>
      createRuntimeFactory({
        provider,
        overrides: { ...codex, resolveExecutable },
        approvedHooks,
        getPersistenceStore: input.getPersistenceStore,
        createCodexFactory: input.createCodexFactory,
      }),
    reapOrphanServices: createCodexOrphanReaper(),
    readLiveNodeIds: createLiveNodeIdsReader(input.getPersistenceStore),
    isStopped: () => stopped,
    onBackgroundError: error =>
      input.log('orchestration background task failed', { error: String(error) }),
  })
  wiring?.attach(service)
  return {
    service,
    links,
    reconcileDeletedNodes: service.reconcileDeletedNodes,
    reviveExecutorTui: async nodeId =>
      (await service.relaunchExecutorTui(nodeId))
        ? (sessions.liveSessionOf(nodeId)?.sessionId ?? null)
        : null,
    boot: createOrchestrationBoot({
      service,
      links,
      hasLiveTui: nodeId => sessions.liveSessionOf(nodeId) !== null,
      events: wiring,
      log: input.log,
      isStopped: () => stopped,
      ready: input.getPersistenceStore,
    }),
    dispose: async () => {
      stopped = true
      wiring?.dispose()
      runState.dispose()
      sessions.dispose()
      tui.dispose()
      try {
        await service.shutdown()
      } finally {
        db.close()
      }
    },
  }
}

const logToStderr: ComposeOrchestrationInput['log'] = (message, details) =>
  process.stderr.write(`[opencove] ${message} ${JSON.stringify(details)}\n`)

const scheduleUnref: ComposeOrchestrationInput['schedule'] = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

export interface LazyOrchestrationInput {
  options: { dbPath?: string }
  getPersistenceStore: ComposeOrchestrationInput['getPersistenceStore']
  topology: ComposeOrchestrationInput['topology']
  ptyRuntime: ComposeOrchestrationInput['ptyRuntime']
  hub: PtyStreamHub
  delivery: PromptDeliveryService
  publish: OrchestrationEventSources['publish']
}

/** Composes on first use, so a Worker without its own database never opens one. */
export function lazyOrchestration(
  input: LazyOrchestrationInput,
  compose: typeof composeOrchestration = composeOrchestration,
): {
  get: () => ComposedOrchestration | null
  /** Starts the services at the start of the Worker, without waiting for the first use. */
  boot: () => Promise<void>
  dispose: () => Promise<void>
} {
  let composed: ComposedOrchestration | null = null
  let disposed = false
  const get = (): ComposedOrchestration | null => {
    const { dbPath } = input.options
    if (!composed && dbPath && !disposed) {
      const { hub } = input
      composed = compose({
        getPersistenceStore: input.getPersistenceStore,
        topology: input.topology,
        ptyRuntime: input.ptyRuntime,
        registry: hub.agentRuns.registry,
        events: {
          registry: hub.agentRuns.registry,
          delivery: input.delivery,
          inputWatermark: sessionId => hub.inputWatermark(sessionId),
          publish: input.publish,
        },
        openDatabase: () => new Database(dbPath),
        schedule: scheduleUnref,
        log: logToStderr,
      })
    }
    return composed
  }
  return {
    get,
    boot: async () => {
      await get()?.boot()
    },
    dispose: async () => {
      disposed = true
      const stopping = composed
      composed = null
      await stopping?.dispose()
    },
  }
}
