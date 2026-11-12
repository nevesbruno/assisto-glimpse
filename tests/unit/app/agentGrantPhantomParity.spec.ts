// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerAgentRunStateHandlers } from '../../../src/app/main/controlSurface/handlers/agentRunStateHandlers'
import { AgentRunStateRegistry } from '../../../src/contexts/agent/application/AgentRunStateRegistry'
import { InMemoryAgentTurnArchive } from '../../support/agentTurnArchive/InMemoryAgentTurnArchive'
import { endedTurn } from '../../support/agentTurnArchive/agentTurnArchiveContract'
import { grantContext, twoProjectGrantStore } from '../../support/grantStateStore'

const grantA = grantContext('project-a')

/** Real registry holding an ended turn for project B's node, in memory and in the archive. */
async function setup(withArchive: boolean) {
  const archive = new InMemoryAgentTurnArchive({ now: () => 1000 })
  const registry = new AgentRunStateRegistry({
    epoch: 'epoch',
    now: () => 1000,
    createTurnId: () => 'turn-b',
    schedule: () => () => {},
    archive: withArchive ? archive : undefined,
    membership: () => 'member',
  })
  registry.register({ sessionId: 'sess-b', nodeId: 'n-b', incarnation: 'i', provider: 'codex' })
  registry.observe(
    'sess-b',
    {
      incarnation: 'i',
      source: 'codex_hook',
      sourceSequence: 1,
      observedAt: 1,
      state: 'working',
      boundary: { kind: 'start', evidence: 'task_started' },
    },
    undefined,
  )
  registry.observe(
    'sess-b',
    {
      incarnation: 'i',
      source: 'codex_hook',
      sourceSequence: 2,
      observedAt: 2,
      state: 'idle',
      boundary: { kind: 'end', outcome: 'completed' },
    },
    {
      providerSessionId: 'sess-b',
      promptId: 'p',
      finalMessage: { message: 'secret', truncated: false },
    },
  )
  archive.append(endedTurn({ nodeId: 'n-b', turnId: 'turn-b', sessionId: 'sess-b' }))
  const control = createControlSurface()
  const store = await twoProjectGrantStore()
  registerAgentRunStateHandlers(
    control,
    { agentRuns: { registry } } as never,
    undefined,
    async () => store,
  )
  const invoke = (kind: 'query' | 'command', id: string, payload: unknown) =>
    control.invoke(grantA, { kind, id, payload } as never)
  /** A missing target seen by an unscoped caller: the reference every denial must match. */
  const invokeUnscoped = (kind: 'query' | 'command', id: string, payload: unknown) =>
    control.invoke({ now: () => new Date() }, { kind, id, payload } as never)
  return { registry, archive, invoke, invokeUnscoped }
}

const masked = (result: unknown, ...ids: string[]) =>
  JSON.parse(ids.reduce((text, id) => text.split(id).join('<id>'), JSON.stringify(result)))

describe('agent.history.clear under a grant', () => {
  it.each([true, false])(
    'answers a foreign node like a missing one and keeps its history (archive %s)',
    async withArchive => {
      const { registry, invoke, invokeUnscoped } = await setup(withArchive)
      const before = registry.list()
      const denied = await invoke('command', 'agent.history.clear', { nodeId: 'n-b' })
      const ghost = await invokeUnscoped('command', 'agent.history.clear', { nodeId: 'ghost' })
      expect(denied.ok).toBe(withArchive)
      expect(masked(denied, 'n-b')).toEqual(masked(ghost, 'ghost'))
      expect(registry.list()).toEqual(before)
      // The throwaway id removed nothing: the real clear still finds B's memory and archive intact.
      expect(registry.clearHistory('n-b')).toMatchObject({
        memoryRemoved: 1,
        archive: withArchive ? { status: 'cleared', removed: 1 } : { status: 'unavailable' },
      })
    },
  )
})

describe('agent.finalMessage under a grant', () => {
  it.each([{}, { turnId: 'turn-b' }])(
    'answers a foreign target like a missing one with the full payload (%j)',
    async selector => {
      const { invoke, invokeUnscoped } = await setup(true)
      const pairs = [
        [{ nodeId: 'n-b', ...selector }, { nodeId: 'ghost', ...selector }, 'n-b', 'ghost'],
        [
          { sessionId: 'sess-b', ...selector },
          { sessionId: 'ghost', ...selector },
          'sess-b',
          'ghost',
        ],
      ] as const
      const replies = await Promise.all(
        pairs.map(async ([foreign, missing]) => [
          await invoke('query', 'agent.finalMessage', foreign),
          await invokeUnscoped('query', 'agent.finalMessage', missing),
        ]),
      )
      replies.forEach(([denied, ghost], index) => {
        const [, , foreignId, missingId] = pairs[index]
        expect(denied.ok).toBe(false)
        expect(masked(denied, foreignId)).toEqual(masked(ghost, missingId))
      })
    },
  )
})
