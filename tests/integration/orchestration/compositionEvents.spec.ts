// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createOrchestrationEvents,
  type OrchestrationEventsDeps,
  type OrchestrationEventsService,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestrationEvents'
import { NOTICE_WINDOW_MS } from '../../../src/contexts/orchestration/application/noticePump'
import type { ExecutorHealth } from '../../../src/contexts/orchestration/application/executorHealth'
import type { ExecutorRuntimeEvent } from '../../../src/contexts/orchestration/application/ports'
import type { SyncEventPayload } from '../../../src/shared/contracts/dto/sync'
import { buildLink } from './persistence/orchestrationDb'

const LINK = buildLink('3b1c0e5a-6d5a-4b8e-9a77-1d3f5c7a9b11')
const DOWN = (reason: string): ExecutorRuntimeEvent => ({
  type: 'executor.down',
  reason,
  exitCode: 1,
  signal: null,
})

function fixture() {
  const eventListeners: ((id: string, event: ExecutorRuntimeEvent) => void)[] = []
  const healthListeners: ((id: string, health: ExecutorHealth) => void)[] = []
  const service: OrchestrationEventsService = {
    subscribeEvents: listener => {
      eventListeners.push(listener)
      return () => void eventListeners.splice(eventListeners.indexOf(listener), 1)
    },
    subscribeHealth: listener => {
      healthListeners.push(listener)
      return () => void healthListeners.splice(healthListeners.indexOf(listener), 1)
    },
    healthOf: () => 'ready',
    markExecutorUnavailable: vi.fn(async () => undefined),
  }
  const timers: (() => void)[] = []
  const enqueued: { orchestratorNodeId: string; entry: { kind: string } }[] = []
  const published: SyncEventPayload[] = []
  const mirrors: unknown[] = []
  const deliver = vi.fn(async () => ({}) as never)
  const deps: OrchestrationEventsDeps = {
    links: {
      listActive: async () => [LINK],
      readLinksRevision: async () => 7,
      findActiveByExecutor: async () => LINK,
    },
    dispatches: { findById: async () => null },
    notices: {
      enqueue: async notice => {
        enqueued.push(notice)
        return { enqueued: true } as never
      },
      listPending: async () => [],
      settleBatch: async () => undefined,
    },
    nodes: { findNode: async () => null },
    clock: { now: () => new Date('2026-11-10T12:00:00Z') },
    ids: { uuid: () => 'op-1' },
    schedule: callback => {
      timers.push(callback)
      return () => undefined
    },
    writeMirror: mirror => mirrors.push(mirror),
    readAppStateRevision: async () => 41,
    log: vi.fn(),
    sources: {
      registry: {
        get: () => undefined,
        subscribe: () => () => undefined,
        list: () => ({ epoch: 'e', seq: 0 }),
      },
      delivery: { deliver },
      inputWatermark: () => null,
      publish: event => void published.push(event),
    },
  }
  const events = createOrchestrationEvents(deps)
  events.attach(service)
  const emit = (event: ExecutorRuntimeEvent) =>
    eventListeners.forEach(listener => listener(LINK.executorNodeId, event))
  const changeHealth = (health: ExecutorHealth) =>
    healthListeners.forEach(listener => listener(LINK.executorNodeId, health))
  return { service, events, emit, changeHealth, enqueued, published, mirrors, timers, deliver }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('orchestration events composition (F2-14 4b1)', () => {
  it('routes an executor event to the supervisor, which queues a notice and pokes the pump', async () => {
    const { emit, enqueued, timers } = fixture()

    emit(DOWN('crashed'))
    await settle()

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      orchestratorNodeId: LINK.orchestratorNodeId,
      entry: { kind: 'executor_down' },
    })
    expect(timers).toHaveLength(1)
    expect(NOTICE_WINDOW_MS).toBeGreaterThan(0)
  })

  it('writes the mirror and publishes links.updated with revision, linksRevision and operationId', async () => {
    const { events, mirrors, published } = fixture()

    events.events.publishLinksUpdated({ linksRevision: 7, projectIds: ['project-1'] })
    await events.idle()

    expect(mirrors).toEqual([
      expect.objectContaining({
        linksRevision: 7,
        links: [expect.objectContaining({ id: LINK.id, health: 'ready' })],
      }),
    ])
    expect(published).toEqual([
      { type: 'orchestration.links.updated', revision: 41, linksRevision: 7, operationId: 'op-1' },
    ])
  })

  it('publishes when the health enters and when it leaves unavailable, and only then', async () => {
    const { events, changeHealth, published } = fixture()

    changeHealth('busy')
    changeHealth('unavailable')
    await events.idle()
    changeHealth('unavailable')
    changeHealth('starting')
    await events.idle()
    changeHealth('ready')
    await events.idle()

    expect(published.map(event => event.type)).toEqual([
      'orchestration.links.updated',
      'orchestration.links.updated',
    ])
  })

  it('turns executor.down with restarts_exhausted into service.unavailable', async () => {
    const { service, emit } = fixture()

    emit(DOWN('crashed'))
    expect(service.markExecutorUnavailable).not.toHaveBeenCalled()
    emit(DOWN('restarts_exhausted'))

    expect(service.markExecutorUnavailable).toHaveBeenCalledExactlyOnceWith(LINK.executorNodeId)
  })

  it('stops reacting after dispose', async () => {
    const { events, emit, enqueued } = fixture()

    events.dispose()
    emit(DOWN('crashed'))
    await settle()

    expect(enqueued).toHaveLength(0)
  })
})
