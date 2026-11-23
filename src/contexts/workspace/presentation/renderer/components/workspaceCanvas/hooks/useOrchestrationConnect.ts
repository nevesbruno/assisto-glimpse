import { useCallback, useRef, useState } from 'react'
import type { Connection, Edge, FinalConnectionState } from '@xyflow/react'
import type { ControlSurfaceInvokeRequest } from '@shared/contracts/controlSurface/request'
import type { OrchestrationLinkDto } from '@shared/contracts/dto/orchestration'
import type { Node } from '@xyflow/react'
import { invokeOrchestrationControlSurface } from '../../../utils/orchestrationCanvasApi'
import type { TerminalNodeData } from '../../../types'
import {
  connectionNodesOf,
  resolveOrchestrationConnection,
  type OrchestrationConnectionHintKey,
  type ResolveOrchestrationConnectionResult,
} from '../helpers/resolveOrchestrationConnection'

export type OrchestrationConnectInvoke = (request: ControlSurfaceInvokeRequest) => Promise<unknown>

export interface OrchestrationConnectConfirmation {
  readonly sourceTitle: string
  readonly targetTitle: string
  /** The target is running a turn that the bootstrap may interrupt. */
  readonly busy: boolean
  /** The target keeps its conversation through the start. */
  readonly reattach: boolean
  readonly inFlight: boolean
  readonly errorCode: string | null
}

export interface OrchestrationConnectPromptState {
  readonly hintKey: OrchestrationConnectionHintKey | null
  readonly confirmation: OrchestrationConnectConfirmation | null
}

export interface OrchestrationConnectApi {
  readonly prompt: OrchestrationConnectPromptState
  readonly isValidConnection: (connection: Connection | Edge) => boolean
  readonly onConnect: (connection: Connection) => void
  readonly onConnectEnd: (event: MouseEvent | TouchEvent, state: FinalConnectionState) => void
  /** The only path that calls `orch.link.create`; nothing runs before this click. */
  readonly accept: () => Promise<void>
  readonly cancel: () => void
}

interface PendingConnection {
  readonly sourceId: string
  readonly targetId: string
  readonly sourceTitle: string
  readonly targetTitle: string
  readonly busy: boolean
  readonly reattach: boolean
  readonly inFlight: boolean
  readonly errorCode: string | null
}

const DROP_ON_EXECUTOR: OrchestrationConnectionHintKey = 'orchestration.connect.hint.dropOnExecutor'

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** The canvas side of the link: the drag evaluates locally, the user confirms, the Worker decides. */
export function useOrchestrationConnect(input: {
  projectId: string
  nodes: Node<TerminalNodeData>[]
  links: OrchestrationLinkDto[]
  invoke?: OrchestrationConnectInvoke
}): OrchestrationConnectApi {
  const { projectId, nodes, links } = input
  const [hintKey, setHintKey] = useState<OrchestrationConnectionHintKey | null>(null)
  const [pending, setPending] = useState<PendingConnection | null>(null)
  const lastPair = useRef<{
    source: string
    target: string
    result: ResolveOrchestrationConnectionResult
  } | null>(null)

  const resolve = useCallback(
    (source: string, target: string) =>
      resolveOrchestrationConnection({
        source,
        target,
        nodes: connectionNodesOf(nodes, projectId),
        links,
      }),
    [projectId, nodes, links],
  )

  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      if (!connection.source || !connection.target) {
        return false
      }
      const result = resolve(connection.source, connection.target)
      lastPair.current = {
        source: connection.source,
        target: connection.target,
        result,
      }
      return result.ok
    },
    [resolve],
  )

  const onConnect = useCallback(
    (connection: Connection): void => {
      const result = resolve(connection.source, connection.target)
      if (!result.ok) {
        setHintKey(result.reason)
        return
      }
      const sourceTitle =
        nodes.find(node => node.id === connection.source)?.data.title ?? connection.source
      const targetTitle =
        nodes.find(node => node.id === connection.target)?.data.title ?? connection.target
      setHintKey(null)
      setPending({
        sourceId: connection.source,
        targetId: connection.target,
        sourceTitle,
        targetTitle,
        busy: result.busy,
        reattach: result.reattach,
        inFlight: false,
        errorCode: null,
      })
    },
    [nodes, resolve],
  )

  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState): void => {
      if (state.isValid && state.toNode) {
        return
      }
      const source = state.fromNode?.id ?? null
      const target = state.toNode?.id ?? null
      if (!source || !target) {
        setHintKey(DROP_ON_EXECUTOR)
        setPending(null)
        return
      }
      const captured = lastPair.current
      const result =
        captured?.source === source && captured.target === target
          ? captured.result
          : resolve(source, target)
      setPending(null)
      setHintKey(result.ok ? null : result.reason)
    },
    [resolve],
  )

  const accept = useCallback(async (): Promise<void> => {
    if (!pending || pending.inFlight) {
      return
    }
    const invoke = input.invoke ?? invokeOrchestrationControlSurface
    setPending({ ...pending, inFlight: true, errorCode: null })
    try {
      await invoke({
        kind: 'command',
        id: 'orch.link.create',
        payload: {
          orchestratorNodeId: pending.sourceId,
          executorNodeId: pending.targetId,
        },
      })
    } catch (error) {
      setPending(current =>
        current
          ? { ...current, inFlight: false, errorCode: codeOf(error) ?? 'common.unexpected' }
          : current,
      )
      return
    }
    setPending(null)
    setHintKey(null)
  }, [input.invoke, pending])

  const cancel = useCallback((): void => {
    setPending(current => (current?.inFlight ? current : null))
  }, [])

  return {
    prompt: {
      hintKey,
      confirmation: pending
        ? {
            sourceTitle: pending.sourceTitle,
            targetTitle: pending.targetTitle,
            busy: pending.busy,
            reattach: pending.reattach,
            inFlight: pending.inFlight,
            errorCode: pending.errorCode,
          }
        : null,
    },
    isValidConnection,
    onConnect,
    onConnectEnd,
    accept,
    cancel,
  }
}
