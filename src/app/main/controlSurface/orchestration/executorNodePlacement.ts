import {
  isPositionAvailable,
  type WorkspacePlacementNode,
} from '../../../../contexts/workspace/domain/workspaceNodePlacementGeometry'

export const EXECUTOR_NODE_GAP = 48
const MAX_EXECUTOR_SLOTS = 64

export interface PlacementRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** First free slot in the column to the right of the orchestrator, filled top to bottom. */
export function placeExecutorNode(input: {
  orchestrator: PlacementRect
  others: readonly PlacementRect[]
  size: { readonly width: number; readonly height: number }
}): { x: number; y: number } {
  const x = input.orchestrator.x + input.orchestrator.width + EXECUTOR_NODE_GAP
  const nodes: WorkspacePlacementNode[] = input.others.map((rect, index) => ({
    id: String(index),
    position: { x: rect.x, y: rect.y },
    data: { width: rect.width, height: rect.height },
  }))
  for (let slot = 0; slot < MAX_EXECUTOR_SLOTS; slot += 1) {
    const y = input.orchestrator.y + slot * (input.size.height + EXECUTOR_NODE_GAP)
    if (isPositionAvailable({ x, y }, input.size, nodes)) {
      return { x, y }
    }
  }
  throw new Error('No free slot beside the orchestrator.')
}
