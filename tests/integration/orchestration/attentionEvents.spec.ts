// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createOrchestrationEvents,
  type OrchestrationEventsDeps,
  type OrchestrationEventsService,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestrationEvents'
import type { ExecutorHealth } from '../../../src/contexts/orchestration/application/executorHealth'
import type { ExecutorRuntimeEvent } from '../../../src/contexts/orchestration/application/ports'
import type { SyncEventPayload } from '../../../src/shared/contracts/dto/sync'
import { buildLink } from './persistence/orchestrationDb'

const LINK = buildLink('3b1c0e5a-6d5a-4b8e-9a77-1d3f5c7a9b11')

function fixture() {
  const eventListeners: ((id: string, event: ExecutorRuntimeEvent) => void)[] = []
  const service: OrchestrationEventsService = {
    subscribeEvents: listener => {
      eventListeners.push(listener)
      return () => void eventListeners.splice(eventListeners.indexOf(listener), 1)
    },
    subscribeHealth: (_listener: (id: string, health: ExecutorHealth) => void) => () => undefined,
    healthOf: () => 'ready',
    markExecutorUnavailable: vi.fn(async () => undefined),
  }
  const published: SyncEventPayload[] = []
  const mirrors: unknown[] = []
  const deps: OrchestrationEventsDeps = {
    links: {
      listActive: async () => [LINK],
      readLinksRevision: async () => 7,
      findActiveByExecutor: async () => LINK,
    },
    dispatches: { findById: async () => null },
    notices: {
      enqueue: async () => ({ enqueued: true }) as never,
      listPending: async () => [],
      settleBatch: async () => undefined,
    },
    nodes: { findNode: async () => null },
    clock: { now: () => new Date('2026-11-10T12:00:00Z') },
    ids: { uuid: () => 'op-1' },
    schedule: () => () => undefined,
    writeMirror: mirror => mirrors.push(mirror),
    readAppStateRevision: async () => 41,
    log: vi.fn(),
    sources: {
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
  const events = createOrchestrationEvents(deps)
  events.attach(service)
  const emit = (event: ExecutorRuntimeEvent) =>
    eventListeners.forEach(listener => listener(LINK.executorNodeId, event))
  return { events, emit, published, mirrors }
}

describe('attention events', () => {
  it('publishes links.updated for approval.requested, approval.resolved and hooks.trust_pending', async () => {
    const { events, emit, published, mirrors } = fixture()

    emit({
      type: 'approval.requested',
      requestId: 'req-1',
      kind: 'command',
      summary: 'rm -rf build',
      turnRef: 'turn-1',
    })
    await events.idle()
    emit({ type: 'approval.resolved', requestId: 'req-1', resolvedBy: 'screen' })
    await events.idle()
    emit({
      type: 'hooks.trust_pending',
      hooks: [{ key: 'k1', event: 'PreToolUse', origin: '/h.sh', currentHash: 'h1' }],
    })
    await events.idle()

    expect(published).toEqual([
      { type: 'orchestration.links.updated', revision: 41, linksRevision: 7, operationId: 'op-1' },
      { type: 'orchestration.links.updated', revision: 41, linksRevision: 7, operationId: 'op-1' },
      { type: 'orchestration.links.updated', revision: 41, linksRevision: 7, operationId: 'op-1' },
    ])
    expect(mirrors).toHaveLength(3)
  })

  it('does not publish for turn events or executor incidents', async () => {
    const { events, emit, published } = fixture()

    emit({ type: 'turn.started', turnRef: 'turn-1', dispatchId: null, origin: 'screen' })
    emit({
      type: 'turn.completed',
      turnRef: 'turn-1',
      dispatchId: null,
      outcome: 'completed',
      finalMessage: 'done',
      usage: null,
    })
    emit({ type: 'executor.degraded', reason: 'sse_down' })
    await events.idle()

    expect(published).toHaveLength(0)
  })
})
