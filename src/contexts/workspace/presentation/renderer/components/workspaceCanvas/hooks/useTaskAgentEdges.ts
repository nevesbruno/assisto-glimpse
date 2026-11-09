import { useMemo } from 'react'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import { useTranslation } from '@app/renderer/i18n'
import type { TerminalNodeData } from '../../../types'
import type { OrchestrationLinkDto } from '@shared/contracts/dto/orchestration'
import { isAgentWorking } from '../helpers'

export function resolveWorkspaceCanvasAgentEdges({
  nodes,
  links = [],
  formatRoleEdgeLabel,
  formatLinkDegradedLabel = () => '',
}: {
  nodes: Node<TerminalNodeData>[]
  links?: OrchestrationLinkDto[]
  formatRoleEdgeLabel: (roleName: string) => string
  formatLinkDegradedLabel?: () => string
}): Edge[] {
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const taskEdges = nodes
    .filter(node => node.data.kind === 'task' && node.data.task?.linkedAgentNodeId)
    .flatMap(taskNode => {
      const linkedAgentNodeId = taskNode.data.task?.linkedAgentNodeId
      if (!linkedAgentNodeId) {
        return []
      }

      const linkedAgentNode = nodeById.get(linkedAgentNodeId)
      if (!linkedAgentNode || linkedAgentNode.data.kind !== 'agent') {
        return []
      }

      const isActive = isAgentWorking(linkedAgentNode.data.status)
      const edgeClassName = isActive
        ? 'workspace-task-agent-edge workspace-task-agent-edge--active'
        : 'workspace-task-agent-edge workspace-task-agent-edge--idle'
      const markerColor = isActive ? 'rgba(121, 197, 255, 0.95)' : 'rgba(130, 168, 214, 0.78)'

      return [
        {
          id: `task-link-${taskNode.id}-${linkedAgentNode.id}`,
          source: taskNode.id,
          target: linkedAgentNode.id,
          type: 'default',
          animated: isActive,
          className: edgeClassName,
          selectable: false,
          focusable: false,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: markerColor,
            width: 22,
            height: 22,
          },
        },
      ]
    })

  const roleEdges = nodes
    .filter(node => node.data.kind === 'role' && node.data.role)
    .flatMap(roleNode => {
      const linkedAgentNodeId =
        roleNode.data.role?.linkedAgentNodeId ??
        roleNode.data.role?.runHistory.find(record => record.agentNodeId)?.agentNodeId ??
        null
      if (!linkedAgentNodeId) {
        return []
      }

      const linkedAgentNode = nodeById.get(linkedAgentNodeId)
      if (!linkedAgentNode || linkedAgentNode.data.kind !== 'agent') {
        return []
      }

      const isActive = isAgentWorking(linkedAgentNode.data.status)
      const edgeClassName = isActive
        ? 'workspace-role-agent-edge workspace-role-agent-edge--active'
        : 'workspace-role-agent-edge workspace-role-agent-edge--idle'
      const markerColor = isActive ? 'rgba(110, 216, 177, 0.95)' : 'rgba(120, 180, 160, 0.78)'
      const roleName = roleNode.data.role?.roleName ?? roleNode.data.title

      return [
        {
          id: `role-link-${roleNode.id}-${linkedAgentNode.id}`,
          source: roleNode.id,
          target: linkedAgentNode.id,
          type: 'default',
          animated: isActive,
          className: edgeClassName,
          selectable: false,
          focusable: false,
          label: formatRoleEdgeLabel(roleName),
          labelStyle: {
            fill: 'var(--cove-text)',
            fontSize: 11,
            fontWeight: 600,
          },
          labelBgPadding: [6, 4] as [number, number],
          labelBgBorderRadius: 5,
          labelBgStyle: {
            fill: 'var(--cove-surface-strong)',
            fillOpacity: 0.92,
            stroke: 'rgba(120, 180, 160, 0.35)',
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: markerColor,
            width: 22,
            height: 22,
          },
        },
      ]
    })

  const linkEdges = links
    .filter(link => link.state === 'active')
    .flatMap(link => {
      const orchestratorNode = nodeById.get(link.orchestratorNodeId)
      const executorNode = nodeById.get(link.executorNodeId)
      if (!orchestratorNode || !executorNode) {
        return []
      }

      const isDegraded = link.health === 'unavailable'
      const isWorking = isAgentWorking(executorNode.data.status)
      const variant = isDegraded ? 'degraded' : isWorking ? 'active' : 'idle'
      const markerColor = isWorking ? 'rgba(121, 197, 255, 0.95)' : 'rgba(130, 168, 214, 0.78)'
      const degradedLabel = isDegraded ? formatLinkDegradedLabel() : ''

      return [
        {
          id: `orch-link-${link.id}`,
          source: orchestratorNode.id,
          target: executorNode.id,
          type: 'default',
          animated: isWorking,
          className: `workspace-orchestration-edge workspace-orchestration-edge--${variant}`,
          selectable: false,
          focusable: false,
          ...(degradedLabel
            ? {
                label: degradedLabel,
                labelStyle: { fill: 'var(--cove-text)', fontSize: 11, fontWeight: 600 },
                labelBgPadding: [6, 4] as [number, number],
                labelBgBorderRadius: 5,
                labelBgStyle: {
                  fill: 'var(--cove-surface-strong)',
                  fillOpacity: 0.92,
                  stroke: 'rgba(130, 168, 214, 0.35)',
                },
              }
            : {}),
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: markerColor,
            width: 22,
            height: 22,
          },
        },
      ]
    })

  return [...taskEdges, ...roleEdges, ...linkEdges]
}

export function useWorkspaceCanvasTaskAgentEdges(
  nodes: Node<TerminalNodeData>[],
  links: OrchestrationLinkDto[] = [],
): Edge[] {
  const { t } = useTranslation()

  return useMemo(() => {
    return resolveWorkspaceCanvasAgentEdges({
      nodes,
      links,
      formatRoleEdgeLabel: roleName => t('roleNode.edgeLabel', { role: roleName }),
      formatLinkDegradedLabel: () => t('orchestration.link.degradedLabel'),
    })
  }, [nodes, links, t])
}
