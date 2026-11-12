import type { Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceCanvasAgentEdges } from '../../../../src/contexts/workspace/presentation/renderer/components/workspaceCanvas/hooks/useTaskAgentEdges'
import type { TerminalNodeData } from '../../../../src/contexts/workspace/presentation/renderer/types'
import type { OrchestrationLinkDto } from '../../../../src/shared/contracts/dto/orchestration'

function node(
  id: string,
  kind: TerminalNodeData['kind'],
  status: TerminalNodeData['status'] = null,
  extra: Partial<TerminalNodeData> = {},
): Node<TerminalNodeData> {
  return {
    id,
    position: { x: 0, y: 0 },
    data: {
      sessionId: '',
      title: id,
      width: 320,
      height: 240,
      kind,
      status,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      lastError: null,
      scrollback: null,
      agent: null,
      task: null,
      note: null,
      role: null,
      image: null,
      document: null,
      website: null,
      ...extra,
    },
  }
}

function link(overrides: Partial<OrchestrationLinkDto> = {}): OrchestrationLinkDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: 'p1',
    spaceId: 's1',
    orchestratorNodeId: 'orch',
    executorNodeId: 'exec',
    kind: 'executor',
    origin: 'orchestrator_spawn',
    runtimeMode: 'service',
    provider: 'codex',
    state: 'active',
    closeReason: null,
    health: 'ready',
    roundsUsed: 0,
    roundsLimit: 10,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    revision: 1,
    ...overrides,
  }
}

const resolve = (nodes: Node<TerminalNodeData>[], links: OrchestrationLinkDto[]) =>
  resolveWorkspaceCanvasAgentEdges({
    nodes,
    links,
    formatRoleEdgeLabel: name => name,
    formatLinkDegradedLabel: () => 'Executor unavailable',
  })

describe('orchestration link edges (U-10)', () => {
  it('draws one non-selectable edge per active link', () => {
    const nodes = [node('orch', 'agent', 'standby'), node('exec', 'agent', 'standby')]
    const edges = resolve(nodes, [link()])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      id: 'orch-link-11111111-1111-4111-8111-111111111111',
      source: 'orch',
      target: 'exec',
      animated: false,
      selectable: false,
      focusable: false,
      className: 'workspace-orchestration-edge workspace-orchestration-edge--idle',
    })
  })

  it('animates while the executor works', () => {
    const nodes = [node('orch', 'agent', 'standby'), node('exec', 'agent', 'running')]
    const [edge] = resolve(nodes, [link()])
    expect(edge.animated).toBe(true)
    expect(edge.className).toContain('--active')
  })

  it('drops the edge when the link closes or a node is missing', () => {
    const nodes = [node('orch', 'agent'), node('exec', 'agent', 'running')]
    expect(resolve(nodes, [link({ state: 'closed', closeReason: 'user' })])).toHaveLength(0)
    expect(resolve(nodes, [link({ state: 'requested' })])).toHaveLength(0)
    expect(resolve([nodes[0]], [link()])).toHaveLength(0)
    expect(resolve([nodes[1]], [link()])).toHaveLength(0)
  })

  it('marks an unavailable executor as degraded with a short label', () => {
    const nodes = [node('orch', 'agent'), node('exec', 'agent', 'running')]
    const [edge] = resolve(nodes, [link({ health: 'unavailable' })])
    expect(edge.className).toContain('--degraded')
    expect(edge.label).toBe('Executor unavailable')
  })

  it('does not duplicate the task-agent edge and keeps its order', () => {
    const task = node('task', 'task', null, {
      task: { linkedAgentNodeId: 'exec' } as TerminalNodeData['task'],
    })
    const nodes = [task, node('orch', 'agent'), node('exec', 'agent', 'running')]
    const edges = resolve(nodes, [link()])
    expect(edges.map(edge => edge.id)).toEqual([
      'task-link-task-exec',
      'orch-link-11111111-1111-4111-8111-111111111111',
    ])
    expect(edges.every(edge => edge.selectable === false)).toBe(true)
  })

  it('draws the edge for an active link whose nodes sit outside any space', () => {
    const nodes = [node('orch', 'agent', 'standby'), node('exec', 'agent', 'standby')]
    const edges = resolve(nodes, [link({ spaceId: '' })])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: 'orch', target: 'exec' })
    expect(edges[0].sourceHandle).toBeUndefined()
  })
})
