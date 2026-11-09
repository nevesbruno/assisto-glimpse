import { describe, expect, it } from 'vitest'
import {
  closeLink,
  createExecutorLink,
  OrchestrationError,
  type AgentLink,
  type CreateExecutorLinkInput,
  type LinkNodeRef,
} from '../../../../../src/contexts/orchestration/domain/agentLink'
import {
  consumeRound,
  extendRounds,
  hasRoundAvailable,
  returnRound,
} from '../../../../../src/contexts/orchestration/domain/roundPolicy'

const now = new Date('2026-11-09T12:00:00.000Z')
const orchestrator: LinkNodeRef = { nodeId: 'orq', projectId: 'p1', provider: 'claude-code' }
const executor: LinkNodeRef = { nodeId: 'exec', projectId: 'p1', provider: 'codex' }

function input(overrides: Partial<CreateExecutorLinkInput> = {}): CreateExecutorLinkInput {
  return {
    id: 'link-1',
    spaceId: 's1',
    orchestrator,
    executor,
    spawnRequestId: null,
    existingLinks: [],
    now,
    ...overrides,
  }
}

function expectInvalid(run: () => unknown): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(OrchestrationError)
    expect((error as OrchestrationError).code).toBe('orch.link_invalid')
    return
  }
  throw new Error('expected orch.link_invalid')
}

describe('agent link (U-01)', () => {
  it('creates an active executor link with phase 2 defaults', () => {
    const link = createExecutorLink(input({ spawnRequestId: 'req-1' }))
    expect(link).toMatchObject({
      kind: 'executor',
      origin: 'orchestrator_spawn',
      runtimeMode: 'service',
      provider: 'codex',
      state: 'active',
      closeReason: null,
      roundsUsed: 0,
      roundsLimit: 3,
      messagesLimit: 5,
      spawnRequestId: 'req-1',
      projectId: 'p1',
      revision: 1,
    })
  })

  it('accepts opencode as executor provider', () => {
    expect(
      createExecutorLink(input({ executor: { ...executor, provider: 'opencode' } })).provider,
    ).toBe('opencode')
  })

  it('L1: refuses a second active link for the same executor', () => {
    const first = createExecutorLink(input())
    expectInvalid(() => createExecutorLink(input({ id: 'link-2', existingLinks: [first] })))
  })

  it('L2: refuses an orchestrator that is not claude-code', () => {
    expectInvalid(() =>
      createExecutorLink(input({ orchestrator: { ...orchestrator, provider: 'codex' } })),
    )
  })

  it('L2: refuses an executor that is claude-code', () => {
    expectInvalid(() =>
      createExecutorLink(input({ executor: { ...executor, provider: 'claude-code' } })),
    )
  })

  it('L2: refuses the same node on both sides', () => {
    expectInvalid(() =>
      createExecutorLink(input({ executor: { ...orchestrator, provider: 'codex' } })),
    )
  })

  it('L2: refuses nodes of different projects', () => {
    expectInvalid(() => createExecutorLink(input({ executor: { ...executor, projectId: 'p2' } })))
  })

  it('L2: an executor of an active link never becomes an orchestrator', () => {
    const asExecutor = createExecutorLink(input({ executor: { ...executor, nodeId: 'x' } }))
    expectInvalid(() =>
      createExecutorLink(
        input({
          id: 'link-2',
          orchestrator: { nodeId: 'x', projectId: 'p1', provider: 'claude-code' },
          executor: { ...executor, nodeId: 'other' },
          existingLinks: [asExecutor],
        }),
      ),
    )
  })

  it('L3: closed is final and relinking creates a new row', () => {
    const first = createExecutorLink(input())
    const closed = closeLink(first, 'user', now)
    expect(closed).toMatchObject({
      state: 'closed',
      closeReason: 'user',
      closedAt: now.toISOString(),
      revision: 2,
    })
    expectInvalid(() => closeLink(closed, 'orchestrator', now))

    const relinked = createExecutorLink(input({ id: 'link-2', existingLinks: [closed] }))
    expect(relinked.id).toBe('link-2')
    expect(relinked.state).toBe('active')
    expect(closed.id).toBe('link-1')
  })

  it('L4: node deletion closes with node_deleted', () => {
    const closed: AgentLink = closeLink(createExecutorLink(input()), 'node_deleted', now)
    expect(closed.closeReason).toBe('node_deleted')
  })
})

describe('round policy (U-04)', () => {
  it('consumes up to the limit and then refuses', () => {
    let counter = { roundsUsed: 0, roundsLimit: 3 }
    for (let round = 1; round <= 3; round += 1) {
      counter = consumeRound(counter)
      expect(counter.roundsUsed).toBe(round)
    }
    expect(hasRoundAvailable(counter)).toBe(false)
    expect(() => consumeRound(counter)).toThrowError(
      expect.objectContaining({ code: 'orch.round_limit_reached' }),
    )
  })

  it('returns a round without going below zero', () => {
    expect(returnRound({ roundsUsed: 2, roundsLimit: 3 }).roundsUsed).toBe(1)
    expect(returnRound({ roundsUsed: 0, roundsLimit: 3 }).roundsUsed).toBe(0)
  })

  it('extends the limit by 1 or 2 and keeps usage', () => {
    expect(extendRounds({ roundsUsed: 3, roundsLimit: 3 }, 2)).toEqual({
      roundsUsed: 3,
      roundsLimit: 5,
    })
    expect(hasRoundAvailable(extendRounds({ roundsUsed: 3, roundsLimit: 3 }, 1))).toBe(true)
  })
})
