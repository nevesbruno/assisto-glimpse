// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeOrchestration,
  lazyOrchestration,
  type ComposedOrchestration,
  type ComposeOrchestrationInput,
  type LazyOrchestrationInput,
  type OrchestrationConnection,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestration'
import { createOrchestrationBoot } from '../../../src/app/main/controlSurface/orchestration/composeOrchestrationBoot'
import { SqliteNoticeOutboxRepository } from '../../../src/contexts/orchestration/infrastructure/persistence/SqliteNoticeOutboxRepository'
import { ORCHESTRATOR_PROVIDER } from '../../../src/contexts/orchestration/domain/agentLink'
import { DEFAULT_AGENT_SETTINGS } from '../../../src/contexts/settings/domain/agentSettings'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import type { SyncEventPayload } from '../../../src/shared/contracts/dto/sync'
import { FakeRuntime } from '../../unit/contexts/orchestration/application/fakes'
import { buildLink, createTempDatabase, type TempDatabase } from './persistence/orchestrationDb'

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

describe('lazyOrchestration (F2-14 4b2)', () => {
  const stub = (): ComposedOrchestration =>
    ({ boot: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) }) as never
  const lazyInput = (dbPath?: string): LazyOrchestrationInput =>
    ({
      options: { dbPath },
      hub: {
        agentRuns: { registry: { onDispose: () => () => undefined } },
        inputWatermark: () => 0,
      },
    }) as never

  it('answers null without a database path and never composes', async () => {
    const compose = vi.fn(stub)
    const lazy = lazyOrchestration(lazyInput(), compose)

    expect(lazy.get()).toBeNull()
    await lazy.boot()

    expect(compose).not.toHaveBeenCalled()
  })

  it('composes on the first get, once', () => {
    const compose = vi.fn(stub)
    const lazy = lazyOrchestration(lazyInput('/db'), compose)

    expect(compose).not.toHaveBeenCalled()
    expect(lazy.get()).toBe(lazy.get())
    expect(compose).toHaveBeenCalledOnce()
  })

  it('boots without waiting for the first get', async () => {
    const composed = stub()
    const lazy = lazyOrchestration(lazyInput('/db'), () => composed)

    await lazy.boot()

    expect(composed.boot).toHaveBeenCalledOnce()
    expect(lazy.get()).toBe(composed)
  })

  it('awaits the dispose of the composition and answers null afterwards', async () => {
    const composed = stub()
    let release = (): void => undefined
    composed.dispose = vi.fn(() => new Promise<void>(resolve => (release = resolve)))
    const lazy = lazyOrchestration(lazyInput('/db'), () => composed)
    lazy.get()

    let done = false
    const disposing = lazy.dispose().then(() => (done = true))
    await settle()
    expect(done).toBe(false)
    release()
    await disposing

    expect(lazy.get()).toBeNull()
  })

  it('does not compose again after dispose', async () => {
    const compose = vi.fn(stub)
    const lazy = lazyOrchestration(lazyInput('/db'), compose)
    await lazy.dispose()

    expect(lazy.get()).toBeNull()
    await lazy.boot()
    expect(compose).not.toHaveBeenCalled()
  })
})

describe('createOrchestrationBoot (F2-14 4b2)', () => {
  function bootFixture(over: { active?: string[]; live?: string[]; stopped?: () => boolean } = {}) {
    const calls: string[] = []
    const log = vi.fn()
    const service = {
      reconcileOnBoot: vi.fn(async () => void calls.push('reconcile')),
      relaunchExecutorTui: vi.fn(async (id: string) => {
        calls.push(`relaunch:${id}`)
        return true
      }),
    }
    const events = {
      sync: vi.fn(async () => void calls.push('sync')),
      poke: vi.fn((orchestratorNodeId: string) => void calls.push(`poke:${orchestratorNodeId}`)),
    }
    const links = {
      listActive: async () =>
        (over.active ?? []).map(id => buildLink(`3b1c0e5a-6d5a-4b8e-9a77-1d3f5c7a9b1${id}`, id)),
    }
    const run = createOrchestrationBoot({
      service,
      links,
      hasLiveTui: id => (over.live ?? []).includes(id),
      events,
      log,
      isStopped: over.stopped ?? (() => false),
    })
    return { run, calls, log, service, events, links }
  }

  it('reconciles, syncs the mirror, pokes the pump and relaunches each executor without a PTY', async () => {
    const { run, calls } = bootFixture({ active: ['1', '2', '3'], live: ['2'] })

    await run()

    expect(calls).toEqual(['reconcile', 'sync', 'poke:orch-1', 'relaunch:1', 'relaunch:3'])
  })

  it('works without event wiring', async () => {
    const { calls, service, links } = bootFixture({ active: ['1'] })
    const run = createOrchestrationBoot({
      service,
      links,
      hasLiveTui: () => false,
      log: vi.fn(),
      isStopped: () => false,
    })

    await run()

    expect(calls).toEqual(['reconcile', 'relaunch:1'])
  })

  it('logs a failure of the boot and does not throw, and a failed relaunch spares the others', async () => {
    const { run, log, service, calls } = bootFixture({ active: ['1', '2'] })
    service.relaunchExecutorTui.mockRejectedValueOnce(new Error('pty down'))

    await expect(run()).resolves.toBeUndefined()
    expect(calls).toContain('relaunch:2')
    expect(log).toHaveBeenCalledWith('orchestration boot step failed', expect.any(Object))

    service.reconcileOnBoot.mockRejectedValueOnce(new Error('db locked'))
    await expect(run()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('stops between steps once the composition is disposed', async () => {
    let stopped = false
    const { run, calls, service } = bootFixture({ active: ['1'], stopped: () => stopped })
    service.reconcileOnBoot.mockImplementation(async () => {
      stopped = true
    })

    await run()

    expect(calls).toEqual([])
  })
})

let database: TempDatabase | null = null
afterEach(() => {
  vi.restoreAllMocks()
  database?.dispose()
  database = null
})

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

function composition() {
  database = createTempDatabase()
  const order: string[] = []
  const runtimes: FakeRuntime[] = []
  const published: SyncEventPayload[] = []
  const state = {
    formatVersion: 1,
    activeWorkspaceId: 'project-1',
    workspaces: [
      {
        id: 'project-1',
        name: 'P',
        path: '/work',
        nodes: [node('orch-1', ORCHESTRATOR_PROVIDER), node('exec-1', 'codex')],
        spaces: [
          { id: 'space-1', name: 'S', directoryPath: '/work', nodeIds: ['orch-1', 'exec-1'] },
        ],
      },
    ],
    settings: DEFAULT_AGENT_SETTINGS,
  }
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => 41,
    writeAppState: async () => ({ ok: true }),
  } as unknown as PersistenceStore
  const log = vi.fn()
  const input: ComposeOrchestrationInput = {
    openDatabase: () => {
      const raw = database!.open()
      return Object.assign(raw, {
        close: () => void order.push('db.close'),
      }) as OrchestrationConnection
    },
    getPersistenceStore: async () => store,
    topology: { listEndpoints: vi.fn(), listMounts: vi.fn() },
    ptyRuntime: {
      spawnSession: vi.fn(async () => ({ sessionId: 'pty-1' })) as never,
      kill: vi.fn(),
      onExit: () => () => {},
    },
    registry: { register: vi.fn(), observe: vi.fn(), get: vi.fn() },
    schedule: () => () => {},
    log,
    codex: {
      startProcess: vi.fn(),
      createClient: vi.fn(),
      resolveExecutable: vi.fn(async () => ({ executablePath: '/bin/codex', version: '1' })),
    },
    createCodexFactory: deps => ({
      probe: async () => ({ executablePath: '/bin/codex', version: '1', compatible: true }),
      start: async spec => {
        await deps.resolveExecutable()
        const runtime = new FakeRuntime(spec)
        runtime.close = async reason => {
          order.push('runtime.close')
          runtime.closes.push(reason)
          runtime.emit({ type: 'executor.down', reason: 'crashed', exitCode: 1, signal: null })
        }
        runtimes.push(runtime)
        return runtime
      },
    }),
    events: {
      registry: {
        get: () => undefined,
        subscribe: () => () => undefined,
        list: () => ({ epoch: 'e', seq: 0 }),
      },
      delivery: { deliver: vi.fn(async () => ({}) as never) },
      inputWatermark: () => null,
      publish: event => void published.push(event),
    },
  }
  const noticeCount = () =>
    (
      database!.open().prepare('SELECT count(*) AS n FROM orchestration_notices').get() as {
        n: number
      }
    ).n
  const link = (composed: ComposedOrchestration) =>
    composed.service.createLink(
      { kind: 'user' },
      { orchestratorNodeId: 'orch-1', executorNodeId: 'exec-1' },
    )
  return {
    composed: composeOrchestration(input),
    order,
    runtimes,
    published,
    noticeCount,
    link,
    log,
  }
}

describe('composition with events (F2-14 4b2)', () => {
  it('publishes links.updated after createLink', async () => {
    const { composed, link, published } = composition()

    await link(composed)
    await settle()

    expect(published.length).toBeGreaterThan(0)
    expect(new Set(published.map(event => event.type))).toEqual(
      new Set(['orchestration.links.updated']),
    )
  })

  it('queues a notice after an event of the executor', async () => {
    const { composed, link, runtimes, noticeCount } = composition()
    await link(composed)

    runtimes[0].emit({ type: 'executor.down', reason: 'crashed', exitCode: 1, signal: null })
    await settle()

    expect(noticeCount()).toBe(1)
  })

  it('turns restarts_exhausted into one notice and an unavailable executor', async () => {
    const enqueue = vi.spyOn(SqliteNoticeOutboxRepository.prototype, 'enqueue')
    const { composed, link, runtimes, noticeCount } = composition()
    await link(composed)

    runtimes[0].emit({
      type: 'executor.down',
      reason: 'restarts_exhausted',
      exitCode: 1,
      signal: null,
    })
    await settle()

    expect(composed.service.healthOf('exec-1')).toBe('unavailable')
    expect(enqueue).toHaveBeenCalledOnce()
    expect(noticeCount()).toBe(1)
  })

  it('boots with the initial mirror sync, logging no failure', async () => {
    const { composed, published, log } = composition()

    await composed.boot()
    await settle()

    expect(published.map(event => event.type)).toContain('orchestration.links.updated')
    expect(log).not.toHaveBeenCalledWith('orchestration boot step failed', expect.anything())
  })

  it('disposes in order: events, then the service shutdown, then the connection', async () => {
    const { composed, link, order, runtimes, noticeCount } = composition()
    await link(composed)

    await composed.dispose()

    expect(order).toEqual(['runtime.close', 'db.close'])
    expect(runtimes[0].closes).toEqual(['shutdown'])
    expect(noticeCount()).toBe(0)
  })
})
