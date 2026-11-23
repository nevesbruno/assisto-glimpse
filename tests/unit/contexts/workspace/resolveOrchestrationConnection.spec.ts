import { describe, expect, it } from 'vitest'
import type { OrchestrationLinkDto } from '@shared/contracts/dto/orchestration'
import {
  resolveOrchestrationConnection,
  type OrchestrationConnectionNode,
} from '../../../../src/contexts/workspace/presentation/renderer/components/workspaceCanvas/helpers/resolveOrchestrationConnection'

const ORCH = 'orch'
const EXEC = 'exec'
const PEER = 'peer'

function node(
  nodeId: string,
  provider: string,
  overrides: Partial<OrchestrationConnectionNode> = {},
): OrchestrationConnectionNode {
  return {
    nodeId,
    projectId: 'p1',
    provider,
    status: 'standby',
    resumeSessionId: null,
    ...overrides,
  }
}

const claude = (nodeId = ORCH, overrides: Partial<OrchestrationConnectionNode> = {}) =>
  node(nodeId, 'claude-code', overrides)

function link(overrides: Partial<OrchestrationLinkDto> = {}): OrchestrationLinkDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: 'p1',
    spaceId: 's1',
    orchestratorNodeId: ORCH,
    executorNodeId: EXEC,
    kind: 'executor',
    origin: 'canvas_manual',
    runtimeMode: 'service',
    provider: 'codex',
    state: 'active',
    closeReason: null,
    health: 'ready',
    roundsUsed: 0,
    roundsLimit: 10,
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
    revision: 1,
    ...overrides,
  }
}

const resolve = (
  nodes: OrchestrationConnectionNode[],
  source: string,
  target: string,
  links: OrchestrationLinkDto[] = [],
) => resolveOrchestrationConnection({ source, target, nodes, links })

describe('resolveOrchestrationConnection matrix (A-01)', () => {
  it('row 1: claude-code to a free codex or opencode is a valid executor link', () => {
    for (const provider of ['codex', 'opencode']) {
      expect(resolve([claude(), node(EXEC, provider)], ORCH, EXEC)).toEqual({
        ok: true,
        kind: 'executor',
        reattach: false,
        busy: false,
      })
    }
  })

  it('row 2: claude-code to claude-code is not an executor link in F3-02a', () => {
    expect(resolve([claude(), claude(PEER)], ORCH, PEER)).toEqual({
      ok: false,
      reason: 'orchestration.connect.hint.peerPending',
    })
  })

  it('row 3: an origin that is not claude-code never organizes work', () => {
    for (const provider of ['codex', 'opencode']) {
      expect(resolve([node(ORCH, provider), claude(PEER)], ORCH, PEER)).toEqual({
        ok: false,
        reason: 'orchestration.connect.hint.sourceNotOrchestrator',
      })
      expect(resolve([node(ORCH, provider), node(EXEC, 'codex')], ORCH, EXEC)).toEqual({
        ok: false,
        reason: 'orchestration.connect.hint.sourceNotOrchestrator',
      })
    }
  })

  it('row 4: the same node on both ends is refused', () => {
    expect(resolve([claude()], ORCH, ORCH)).toEqual({
      ok: false,
      reason: 'orchestration.connect.hint.sameNode',
    })
  })

  it('row 5: a source that executes for an orchestrator cannot organize another', () => {
    const nodes = [claude(), node(EXEC, 'codex')]
    expect(
      resolve(nodes, ORCH, EXEC, [link({ orchestratorNodeId: PEER, executorNodeId: ORCH })]),
    ).toEqual({ ok: false, reason: 'orchestration.connect.hint.orchestratorIsExecutor' })
  })

  it('row 6: a target that already executes for an orchestrator is refused', () => {
    expect(resolve([claude(), node(EXEC, 'codex')], ORCH, EXEC, [link()])).toEqual({
      ok: false,
      reason: 'orchestration.connect.hint.targetLinked',
    })
  })

  it('row 7: a claude-code target with an active peer link stays unsupported in F3-02a', () => {
    expect(
      resolve([claude(), claude(PEER)], ORCH, PEER, [
        link({ kind: 'peer', executorNodeId: PEER, runtimeMode: 'terminal' }),
      ]),
    ).toEqual({ ok: false, reason: 'orchestration.connect.hint.peerPending' })
  })

  it('row 8: the two sessions must share a project', () => {
    expect(resolve([claude(), node(EXEC, 'codex', { projectId: 'p2' })], ORCH, EXEC)).toEqual({
      ok: false,
      reason: 'orchestration.connect.hint.crossProject',
    })
  })

  it('row 9: a working target is valid and reports the running turn', () => {
    expect(resolve([claude(), node(EXEC, 'codex', { status: 'running' })], ORCH, EXEC)).toEqual({
      ok: true,
      kind: 'executor',
      reattach: false,
      busy: true,
    })
  })

  it('row 10: a target with a conversation is valid and reports the reattach', () => {
    expect(
      resolve([claude(), node(EXEC, 'opencode', { resumeSessionId: 'ses-1' })], ORCH, EXEC),
    ).toEqual({ ok: true, kind: 'executor', reattach: true, busy: false })
  })

  it('row 11: a release without a target asks for the executor session', () => {
    expect(resolve([claude(), node(EXEC, 'codex')], ORCH, 'canvas')).toEqual({
      ok: false,
      reason: 'orchestration.connect.hint.dropOnExecutor',
    })
  })
})
