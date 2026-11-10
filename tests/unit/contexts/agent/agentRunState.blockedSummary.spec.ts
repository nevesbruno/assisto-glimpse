import { describe, expect, it } from 'vitest'
import {
  createAgentRunModel,
  transitionAgentRun,
  type AgentRunObservation,
} from '../../../../src/contexts/agent/domain/agentRunState'

function run(
  observations: Array<Partial<AgentRunObservation> & Pick<AgentRunObservation, 'state'>>,
) {
  let model = createAgentRunModel({
    sessionId: 's',
    provider: 'codex',
    incarnation: 'i',
    now: 0,
  })
  let at = 100
  for (const [index, fields] of observations.entries()) {
    at += 10
    model = transitionAgentRun(
      model,
      {
        incarnation: 'i',
        source: 'executor_service',
        observedAt: at,
        sourceSequence: index + 1,
        ...fields,
      },
      at,
      () => 'turn',
    ).model
  }
  return model.snapshot
}

describe('F2-17a: blockedSummary in the reducer', () => {
  it('follows blockedReason: present only while waiting', () => {
    const waiting = run([
      { state: 'waiting', blockedReason: 'permission', blockedSummary: 'run ls' },
    ])
    expect(waiting).toMatchObject({ state: 'waiting', blockedSummary: 'run ls' })

    const working = run([
      { state: 'waiting', blockedReason: 'permission', blockedSummary: 'run ls' },
      { state: 'working' },
    ])
    expect(working.state).toBe('working')
    expect(working.blockedSummary ?? null).toBeNull()
  })

  it('stays null when the waiting observation has no summary', () => {
    const snapshot = run([{ state: 'waiting', blockedReason: 'permission' }])
    expect(snapshot.blockedSummary ?? null).toBeNull()
  })
})
