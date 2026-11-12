import { useEffect, useRef } from 'react'
import type { TerminalSessionState, TerminalSessionStateEvent } from '@shared/contracts/dto'
import type { AgentRuntimeStatus } from '@contexts/agent/domain/types'
import type { WorkspaceState } from '@contexts/workspace/presentation/renderer/types'
import { isAgentNodeAwaitingSessionTitle } from '@contexts/workspace/presentation/renderer/utils/agentSessionTitleSync'
import { resolveAgentPresentation } from '@contexts/workspace/presentation/renderer/utils/agentPresentation'
import { orchestrationLinks } from '@contexts/orchestration/presentation/renderer/orchestrationLinksStore'
import { useAppStore } from '../store/useAppStore'
import type { ExecutorAlert } from '../utils/agentStandbyNotification'
import { getPtyEventHub } from '../utils/ptyEventHub'

function normalizeSessionId(rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') {
    return null
  }

  const trimmed = rawValue.trim()
  return trimmed.length > 0 ? trimmed : null
}

type ResolvedAgentNode = {
  sessionId: string
  workspaceId: string
  workspaceName: string
  workspacePath: string
  nodeId: string
  title: string
  awaitingSessionTitle: boolean
  runtimeStatus: AgentRuntimeStatus | null
  executionDirectory: string
  taskId: string | null
}

export function resolveAgentNodeForSessionId(sessionId: string): ResolvedAgentNode | null {
  return findAgentNode(node => node.data.sessionId === sessionId)
}

function findAgentNode(
  matches: (node: WorkspaceState['nodes'][number]) => boolean,
): ResolvedAgentNode | null {
  const state = useAppStore.getState()

  for (const workspace of state.workspaces) {
    for (const node of workspace.nodes) {
      const sessionId = node.data.sessionId
      if (!sessionId || !matches(node)) {
        continue
      }
      const presentation = resolveAgentPresentation(node.data)
      if (!presentation.isAgent) {
        continue
      }

      const taskId = node.data.agent?.taskId ?? null
      const agent = node.data.agent
      const resolvedExecutionDirectory =
        node.data.executionDirectory ?? agent?.executionDirectory ?? workspace.path

      return {
        sessionId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
        nodeId: node.id,
        title: node.data.title,
        awaitingSessionTitle: isAgentNodeAwaitingSessionTitle(node),
        runtimeStatus: presentation.status,
        executionDirectory: resolvedExecutionDirectory,
        taskId,
      }
    }
  }

  return null
}

export type AgentStandbyNotificationPayload = {
  sessionId: string
  workspaceId: string
  workspaceName: string
  workspacePath: string
  nodeId: string
  title: string
  awaitingSessionTitle: boolean
  executionDirectory: string
  taskId: string | null
  /** Set for a linked executor that stopped on a request or became unavailable. */
  alert?: ExecutorAlert | null
}

/** Executors of active links, with their health; the display copy, never an authorization. */
function readExecutorHealth(): Map<string, string> {
  const executors = new Map<string, string>()
  for (const link of orchestrationLinks.store.getState().links) {
    if (link.kind === 'executor' && link.state === 'active') {
      executors.set(link.executorNodeId, link.health)
    }
  }
  return executors
}

function toPayload(resolved: ResolvedAgentNode): AgentStandbyNotificationPayload {
  return {
    sessionId: resolved.sessionId,
    workspaceId: resolved.workspaceId,
    workspaceName: resolved.workspaceName,
    workspacePath: resolved.workspacePath,
    nodeId: resolved.nodeId,
    title: resolved.title,
    awaitingSessionTitle: resolved.awaitingSessionTitle,
    executionDirectory: resolved.executionDirectory,
    taskId: resolved.taskId,
  }
}

/** `blockedSummary` only means something while the run state is `waiting`. */
function readExecutorWait(event: TerminalSessionStateEvent): ExecutorAlert | null {
  const snapshot = event.agentRunState
  if (event.state !== 'waiting' || snapshot?.state !== 'waiting') {
    return null
  }
  return snapshot.blockedReason === 'permission'
    ? { reason: 'permission', summary: snapshot.blockedSummary ?? null }
    : null
}

export function useAgentStandbyNotificationWatcher({
  enabled = true,
  onAgentEnteredStandby,
  onAgentEnteredWorking,
}: {
  enabled?: boolean
  onAgentEnteredStandby: (payload: AgentStandbyNotificationPayload) => void
  onAgentEnteredWorking: (sessionId: string) => void
}): void {
  const lastStateBySessionIdRef = useRef<Map<string, TerminalSessionState>>(new Map())
  // Sessions of linked executors with an open alert: leaving the pendency closes it.
  const alertedSessionsRef = useRef<Set<string>>(new Set())
  const standbyHandlerRef = useRef(onAgentEnteredStandby)
  const workingHandlerRef = useRef(onAgentEnteredWorking)

  useEffect(() => {
    standbyHandlerRef.current = onAgentEnteredStandby
  }, [onAgentEnteredStandby])

  useEffect(() => {
    workingHandlerRef.current = onAgentEnteredWorking
  }, [onAgentEnteredWorking])

  useEffect(() => {
    if (!enabled) {
      return
    }

    // A wait that began before we listened was already there at startup: a baseline, not news.
    const listeningSinceMs = Date.now()
    const ptyEventHub = getPtyEventHub()
    const unavailableNodeIds = new Set<string>()
    const unsubscribe = ptyEventHub.onState((event: TerminalSessionStateEvent) => {
      const sessionId = normalizeSessionId(event.sessionId)
      if (!sessionId) {
        return
      }

      if (event.agentRunState?.state === 'unknown') {
        return
      }
      const previous = lastStateBySessionIdRef.current.get(sessionId) ?? null
      lastStateBySessionIdRef.current.set(sessionId, event.state)

      const alertedSessions = alertedSessionsRef.current
      const executorWait = readExecutorWait(event)
      if (alertedSessions.has(sessionId) && !executorWait) {
        alertedSessions.delete(sessionId)
        const nodeId = resolveAgentNodeForSessionId(sessionId)?.nodeId
        // Still unavailable: that alert keeps calling.
        if (!nodeId || !unavailableNodeIds.has(nodeId)) {
          workingHandlerRef.current(sessionId)
        }
      }

      if (event.state === 'working') {
        workingHandlerRef.current(sessionId)
        return
      }

      if (event.state === 'waiting') {
        if (executorWait && !alertedSessions.has(sessionId)) {
          const resolved = resolveAgentNodeForSessionId(sessionId)
          if (resolved && readExecutorHealth().has(resolved.nodeId)) {
            alertedSessions.add(sessionId)
            standbyHandlerRef.current({ ...toPayload(resolved), alert: executorWait })
          }
        }
        return
      }

      if (
        previous === null &&
        typeof event.observedAtMs === 'number' &&
        event.observedAtMs < listeningSinceMs
      ) {
        return
      }

      const resolved = resolveAgentNodeForSessionId(sessionId)
      if (!resolved) {
        return
      }

      // A restoring Agent replays the state it had: it was not seen working, so it is a baseline.
      const inferredPrevious: TerminalSessionState | null =
        previous ??
        (resolved.runtimeStatus === 'running'
          ? 'working'
          : resolved.runtimeStatus === 'standby'
            ? 'standby'
            : null)

      if (inferredPrevious !== 'working') {
        return
      }

      // A linked executor ending a turn is the orchestrator's business: only its approval
      // requests and unavailability reach the user.
      if (readExecutorHealth().has(resolved.nodeId)) {
        return
      }

      standbyHandlerRef.current(toPayload(resolved))
    })

    // An unavailable executor has no run state to say so: its link health does. The first read
    // of the mirror is a baseline, not news.
    let linksRevision = orchestrationLinks.store.getState().linksRevision
    const unsubscribeLinks = orchestrationLinks.store.subscribe(state => {
      const baseline = linksRevision === 0
      linksRevision = state.linksRevision
      const health = readExecutorHealth()
      for (const nodeId of unavailableNodeIds) {
        if (health.get(nodeId) === 'unavailable') {
          continue
        }
        unavailableNodeIds.delete(nodeId)
        const sessionId = findAgentNode(node => node.id === nodeId)?.sessionId
        if (sessionId && !alertedSessionsRef.current.has(sessionId)) {
          workingHandlerRef.current(sessionId)
        }
      }
      for (const [nodeId, nodeHealth] of health) {
        if (nodeHealth !== 'unavailable' || unavailableNodeIds.has(nodeId)) {
          continue
        }
        unavailableNodeIds.add(nodeId)
        const resolved = baseline ? null : findAgentNode(node => node.id === nodeId)
        if (resolved) {
          standbyHandlerRef.current({
            ...toPayload(resolved),
            alert: { reason: 'unavailable', summary: null },
          })
        }
      }
    })

    return () => {
      unsubscribe()
      unsubscribeLinks()
    }
  }, [enabled])
}
