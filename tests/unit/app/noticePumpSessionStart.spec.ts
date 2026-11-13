import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRunStateRegistry } from '../../../src/contexts/agent/application/AgentRunStateRegistry'
import { AgentRunStateRuntime } from '../../../src/contexts/agent/application/AgentRunStateRuntime'
import { createOrchestratorReadiness } from '../../../src/app/main/controlSurface/orchestration/orchestratorReadiness'
import { createNoticePump } from '../../../src/contexts/orchestration/application/noticePump'
import type { StoredNotice } from '../../../src/contexts/orchestration/application/ports'

const NODE = 'orq'
const SESSION = 'session-1'

const notice = (): StoredNotice => ({
  id: 'n1',
  orchestratorNodeId: NODE,
  dedupeKey: 'n1',
  state: 'pending',
  batchId: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  settledAt: null,
  entry: {
    executorNodeId: 'exec',
    executorName: 'alpha',
    provider: 'codex',
    kind: 'executor_down_in_turn',
    round: 1,
    roundsLimit: 3,
    dispatchId: '7f3a0000-0000-4000-8000-000000000000',
    glimpseTurnId: 't1',
    excerpt: null,
    createdAt: '2026-11-12T10:00:00.000Z',
  },
})

afterEach(() => {
  vi.useRealTimers()
})

function fixture() {
  const registry = new AgentRunStateRegistry({
    epoch: 'e',
    now: () => Date.now(),
    createTurnId: () => 'turn',
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
  })
  const runtime = new AgentRunStateRuntime(registry, () => Date.now())
  const readiness = createOrchestratorReadiness({
    registry,
    inputWatermark: () => null,
    deliveryInFlight: () => false,
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
  })
  const settlements: string[] = []
  const pump = createNoticePump({
    notices: {
      listPending: async () => [notice()],
      settleBatch: async (_ids, _batchId, state) => {
        settlements.push(state)
      },
    },
    delivery: { deliver: async () => 'delivered' as const },
    readiness,
    clock: { now: () => new Date() },
    ids: { uuid: () => 'batch' },
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
    windowMs: 5,
  })
  const wait = (predicate: () => boolean, timeoutMs = 2_000) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        if (predicate()) {
          resolve()
        } else if (Date.now() - started > timeoutMs) {
          reject(new Error('condition not met'))
        } else {
          setTimeout(tick, 5)
        }
      }
      tick()
    })
  return { registry, runtime, pump, settlements, wait }
}

describe('notice delivery after a crash restart (wave 6 R1)', () => {
  it('delivers once the resumed session reports the provider identity, with the pump opened before it', async () => {
    const f = fixture()
    f.runtime.metadata({
      sessionId: SESSION,
      resumeSessionId: null,
      agentProvider: 'claude-code',
      hookCoverage: 'lifecycle',
      hookInstallState: 'installed',
    })
    f.pump.poke(NODE)
    f.runtime.setBindings([{ sessionId: SESSION, nodeId: NODE, projectId: 'p', remote: false }])
    f.runtime.metadata({ sessionId: SESSION, resumeSessionId: 'provider-thread' })
    await f.wait(() => f.settlements.length === 1)
    expect(f.settlements).toEqual(['delivered'])
    f.pump.dispose()
    f.runtime.dispose()
  })

  it('delivers when the pump is opened after the identity and the binding', async () => {
    const f = fixture()
    f.runtime.metadata({
      sessionId: SESSION,
      resumeSessionId: null,
      agentProvider: 'claude-code',
      hookCoverage: 'lifecycle',
      hookInstallState: 'installed',
    })
    f.runtime.setBindings([{ sessionId: SESSION, nodeId: NODE, projectId: 'p', remote: false }])
    f.runtime.metadata({ sessionId: SESSION, resumeSessionId: 'provider-thread' })
    f.pump.poke(NODE)
    await f.wait(() => f.settlements.length === 1)
    expect(f.settlements).toEqual(['delivered'])
    f.pump.dispose()
    f.runtime.dispose()
  })
})
