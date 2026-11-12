import { setTimeout as realDelay } from 'node:timers/promises'
import { vi } from 'vitest'
import {
  composeOrchestration,
  type ComposedOrchestration,
  type ComposeOrchestrationInput,
  type OrchestrationConnection,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestration'
import { ORCHESTRATOR_PROVIDER } from '../../../src/contexts/orchestration/domain/agentLink'
import { DEFAULT_AGENT_SETTINGS } from '../../../src/contexts/settings/domain/agentSettings'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import { createAppError } from '../../../src/shared/errors/appError'
import {
  FakeRuntime,
  orchestratorPrincipal,
} from '../../unit/contexts/orchestration/application/fakes'
import { createTempDatabase, type TempDatabase } from './persistence/orchestrationDb'

export const ORCHESTRATOR_NODE = 'orch-1'
export const EXECUTOR_NODE = 'exec-1'
export const ORCHESTRATOR_SESSION = 'session-orch-1'
export const AS_ORCHESTRATOR = {
  ...orchestratorPrincipal(ORCHESTRATOR_NODE),
  projectId: 'project-1',
  spaceId: 'space-1',
}
export const AS_USER = { kind: 'user' } as const
export const dispatchId = (n: number): string =>
  `5b1c0000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Settles the promise chains and every fake timer that is due, with `vi.useFakeTimers()` on. */
export const settle = (ms = 0): Promise<void> => vi.advanceTimersByTimeAsync(ms)

/**
 * Waits in real time for work the fake clock does not drive: the real orphan reaper shells out to
 * `ps` during the boot, so `settle()` alone can return before the reconciliation starts.
 */
export async function waitForRealIO(check: () => boolean, attempts = 1000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) {
      return
    }
    // oxlint-disable-next-line no-await-in-loop -- real time must elapse between attempts
    await realDelay(5)
  }
  throw new Error('real I/O did not finish in time')
}

const node = (id: string, provider: string) => ({
  id,
  title: id,
  position: { x: 0, y: 0 },
  width: 400,
  height: 300,
  kind: 'agent',
  status: 'running',
  startedAt: null,
  endedAt: null,
  exitCode: null,
  lastError: null,
  scrollback: null,
  executionDirectory: '/work',
  agent: { provider, prompt: '', model: null, effectiveModel: null, launchMode: 'new' },
})

function appState() {
  return {
    formatVersion: 1,
    activeWorkspaceId: 'project-1',
    workspaces: [
      {
        id: 'project-1',
        name: 'P',
        path: '/work',
        nodes: [node(ORCHESTRATOR_NODE, ORCHESTRATOR_PROVIDER), node(EXECUTOR_NODE, 'codex')],
        spaces: [
          {
            id: 'space-1',
            name: 'S',
            directoryPath: '/work',
            nodeIds: [ORCHESTRATOR_NODE, EXECUTOR_NODE],
          },
        ],
      },
    ],
    settings: DEFAULT_AGENT_SETTINGS,
  }
}

export type DeliveryMode = 'delivered' | 'busy' | 'uncertain'

export interface OrchestratorControl {
  /** State of the orchestrator in the run state registry. */
  setRun: (patch: { state?: string; quality?: string }) => void
  /** Instant (epoch ms) of the last typed write, or null. */
  typedAt: number | null
  deliveryMode: DeliveryMode
  readonly deliveries: { text: string; deliveryId: string }[]
}

export interface RigWorker {
  readonly composed: ComposedOrchestration
  readonly runtimes: FakeRuntime[]
  readonly control: OrchestratorControl
  readonly spawnSession: ReturnType<typeof vi.fn>
  readonly log: ReturnType<typeof vi.fn>
  /** The Worker dies without any shutdown: nothing it scheduled fires any more. */
  kill: () => void
}

export interface WorkerOptions {
  createCodexFactory?: ComposeOrchestrationInput['createCodexFactory']
  /** Runs for every FakeRuntime this Worker starts, before it is returned to the service. */
  onRuntime?: (runtime: FakeRuntime) => void
}

export interface Rig {
  readonly database: TempDatabase
  startWorker: (options?: WorkerOptions) => RigWorker
  /** Rows of the notice outbox, in order of creation. */
  notices: () => { kind: string; dedupeKey: string; state: string; batchId: string | null }[]
  dispatchRow: (id: string) => { state: string; reason: string | null; round: number } | undefined
  linkRow: () => { roundsUsed: number; state: string } | undefined
  dispose: () => void
}

function createControl(): {
  control: OrchestratorControl
  registry: ComposeOrchestrationInput['registry']
  eventsRegistry: NonNullable<ComposeOrchestrationInput['events']>['registry']
} {
  const listeners = new Set<() => void>()
  let snapshot = {
    nodeId: ORCHESTRATOR_NODE,
    sessionId: ORCHESTRATOR_SESSION,
    state: 'idle',
    quality: 'authoritative',
  }
  const control: OrchestratorControl = {
    setRun: patch => {
      snapshot = { ...snapshot, ...patch }
      listeners.forEach(listener => listener())
    },
    typedAt: null,
    deliveryMode: 'delivered',
    deliveries: [],
  }
  return {
    control,
    registry: { register: vi.fn(), observe: vi.fn(), get: vi.fn() },
    eventsRegistry: {
      get: () => snapshot,
      subscribe: (_cursor: unknown, _filter: unknown, listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      list: () => ({ epoch: 'e', seq: 0 }),
    } as never,
  }
}

/** Real SQLite file, real composition and real grants; the runtime and the clock are fakes. */
export function createRig(): Rig {
  const database = createTempDatabase()
  const state = appState()
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => 41,
    writeAppState: async () => ({ ok: true }),
  } as unknown as PersistenceStore
  const count = <T>(sql: string, ...args: string[]): T[] =>
    database
      .open()
      .prepare(sql)
      .all(...args) as T[]

  return {
    database,
    startWorker(options = {}) {
      let dead = false
      const runtimes: FakeRuntime[] = []
      const { control, registry, eventsRegistry } = createControl()
      const spawnSession = vi.fn(async () => ({ sessionId: `pty-${runtimes.length}` }))
      const log = vi.fn()
      const alive =
        <A extends unknown[]>(run: (...args: A) => void) =>
        (...args: A) =>
          dead ? undefined : run(...args)
      const input: ComposeOrchestrationInput = {
        openDatabase: () =>
          Object.assign(database.open(), { close: () => undefined }) as OrchestrationConnection,
        getPersistenceStore: async () => store,
        topology: { listEndpoints: vi.fn(), listMounts: vi.fn() },
        ptyRuntime: { spawnSession: spawnSession as never, kill: vi.fn(), onExit: () => () => {} },
        registry,
        schedule: (callback, delayMs) => {
          const timer = setTimeout(alive(callback), delayMs)
          return () => clearTimeout(timer)
        },
        log,
        codex: {
          startProcess: vi.fn(),
          createClient: vi.fn(),
          resolveExecutable: vi.fn(async () => ({ executablePath: '/bin/codex', version: '1' })),
        },
        createCodexFactory:
          options.createCodexFactory ??
          (deps => ({
            probe: async () => ({ executablePath: '/bin/codex', version: '1', compatible: true }),
            start: async spec => {
              await deps.resolveExecutable()
              const runtime = new FakeRuntime(spec)
              options.onRuntime?.(runtime)
              runtimes.push(runtime)
              return runtime
            },
          })),
        events: {
          registry: eventsRegistry,
          delivery: {
            deliver: vi.fn(async ({ text, deliveryId }: { text: string; deliveryId: string }) => {
              if (dead) {
                throw new Error('the Worker is dead')
              }
              control.deliveries.push({ text, deliveryId })
              if (control.deliveryMode === 'busy') {
                throw createAppError('agent.busy', { details: { pasteDispatchAttempted: false } })
              }
              if (control.deliveryMode === 'uncertain') {
                throw new Error('paste outcome unknown')
              }
              return {} as never
            }) as never,
          },
          inputWatermark: () => control.typedAt,
          publish: vi.fn(),
        },
        now: () => new Date(),
      }
      return {
        composed: composeOrchestration(input),
        runtimes,
        control,
        spawnSession,
        log,
        kill: () => {
          dead = true
        },
      }
    },
    notices: () =>
      count<{ kind: string; dedupeKey: string; state: string; batchId: string | null }>(
        `SELECT kind, dedupe_key AS dedupeKey, delivery_state AS state, batch_id AS batchId
         FROM orchestration_notices ORDER BY created_at, rowid`,
      ),
    dispatchRow: id =>
      count<{ state: string; reason: string | null; round: number }>(
        'SELECT state, reason, round FROM orchestration_dispatches WHERE id = ?',
        id,
      )[0],
    linkRow: () =>
      count<{ roundsUsed: number; state: string }>(
        'SELECT rounds_used AS roundsUsed, state FROM agent_links LIMIT 1',
      )[0],
    dispose: () => database.dispose(),
  }
}

export async function linkExecutor(worker: RigWorker): Promise<void> {
  await worker.composed.service.createLink(AS_USER, {
    orchestratorNodeId: ORCHESTRATOR_NODE,
    executorNodeId: EXECUTOR_NODE,
  })
  await settle()
}

/** The Worker boots (the pump is idle before that) and links the executor, which starts its service and marks it ready. */
export async function bootAndLink(worker: RigWorker): Promise<void> {
  await worker.composed.boot()
  await linkExecutor(worker)
}
