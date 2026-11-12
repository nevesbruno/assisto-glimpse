import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'
import type { TerminalSessionStateEvent } from '../../../src/shared/contracts/dto'
import type { OrchestrationLinkDto } from '../../../src/shared/contracts/dto/orchestration'
import type { TerminalNodeData } from '../../../src/contexts/workspace/presentation/renderer/types'
import { orchestrationLinks } from '../../../src/contexts/orchestration/presentation/renderer/orchestrationLinksStore'
import {
  useAgentStandbyNotificationWatcher,
  type AgentStandbyNotificationPayload as AgentStandbyPayload,
} from '../../../src/app/renderer/shell/hooks/useAgentStandbyNotificationWatcher'
import { formatAgentAttentionSystemNotification } from '../../../src/app/renderer/shell/hooks/useAgentStandbyNotifications'
import {
  createAgentAttentionRouter,
  type AgentAttentionEffect,
} from '../../../src/app/renderer/shell/utils/agentAttentionRouter'
import { summarizeAgentActivity } from '../../../src/app/renderer/shell/utils/agentActivitySummary'
import type { WorkspaceState } from '../../../src/contexts/workspace/presentation/renderer/types'
import {
  agentAttentionKey,
  executorAttentionKey,
  resolveNeedsYouSinceMs,
} from '../../../src/app/renderer/shell/utils/sidebarAgents'
import type { AgentStandbyNotification } from '../../../src/app/renderer/shell/utils/agentStandbyNotification'
import {
  useAgentAttentionStore,
  useAgentsNeedingYou,
} from '../../../src/app/renderer/shell/store/useAgentAttentionStore'
import { AgentIslandCard } from '../../../src/app/renderer/shell/components/AgentIslandCard'
import { DEFAULT_AGENT_SETTINGS } from '../../../src/contexts/settings/domain/agentSettings'

const harness = vi.hoisted(() => ({
  onState: null as ((event: TerminalSessionStateEvent) => void) | null,
}))

vi.mock('../../../src/app/renderer/shell/store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      workspaces: [
        {
          id: 'workspace',
          name: 'Workspace',
          path: '/workspace',
          nodes: ['exec', 'plain'].map(id => ({
            id,
            data: {
              kind: 'agent',
              sessionId: `pty-${id}`,
              title: id === 'exec' ? 'Codex executor' : 'Plain agent',
              status: 'running',
              agent: null,
              agentOverlay: null,
            },
          })),
        },
      ],
    }),
  },
}))
vi.mock('../../../src/app/renderer/shell/utils/ptyEventHub', () => ({
  getPtyEventHub: () => ({
    onState: (listener: (event: TerminalSessionStateEvent) => void) => {
      harness.onState = listener
      return () => {
        harness.onState = null
      }
    },
  }),
}))

function link(health: OrchestrationLinkDto['health'], executorNodeId = 'exec') {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: 'workspace',
    spaceId: 'space',
    orchestratorNodeId: 'orch',
    executorNodeId,
    kind: 'executor',
    origin: 'orchestrator',
    runtimeMode: 'service',
    provider: 'codex',
    state: 'active',
    closeReason: null,
    health,
    roundsUsed: 0,
    roundsLimit: 5,
    createdAt: 'now',
    updatedAt: 'now',
    revision: 1,
  } as unknown as OrchestrationLinkDto
}

function setLinks(linksRevision: number, links: OrchestrationLinkDto[]): void {
  act(() => orchestrationLinks.store.setState({ linksRevision, links }))
}

function waitingEvent(
  sessionId: string,
  blockedReason: 'permission' | 'question',
  blockedSummary: string | null,
  state: 'waiting' | 'working' = 'waiting',
): TerminalSessionStateEvent {
  return {
    sessionId,
    state: 'waiting',
    agentRunState: { state, blockedReason, blockedSummary } as never,
  }
}

beforeEach(() => orchestrationLinks.store.setState({ linksRevision: 0, links: [] }))
afterEach(cleanup)

describe('U-11 executor attention: the watcher', () => {
  function mount() {
    const onStandby = vi.fn()
    const onWorking = vi.fn()
    renderHook(() =>
      useAgentStandbyNotificationWatcher({
        onAgentEnteredStandby: onStandby,
        onAgentEnteredWorking: onWorking,
      }),
    )
    return { onStandby, onWorking }
  }

  it('alerts once, with the executor name and the request summary, on a permission wait', () => {
    setLinks(1, [link('ready')])
    const { onStandby } = mount()
    act(() => harness.onState?.(waitingEvent('pty-exec', 'permission', 'Run pnpm test')))
    act(() => harness.onState?.(waitingEvent('pty-exec', 'permission', 'Run pnpm test')))
    expect(onStandby).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'pty-exec',
        nodeId: 'exec',
        title: 'Codex executor',
        alert: { reason: 'permission', summary: 'Run pnpm test' },
      }),
    )
  })

  it('leaves a common Agent waiting on permission without an alert', () => {
    setLinks(1, [link('ready')])
    const { onStandby } = mount()
    act(() => harness.onState?.(waitingEvent('pty-plain', 'permission', 'Run pnpm test')))
    expect(onStandby).not.toHaveBeenCalled()
  })

  it('ignores a question wait and a stale summary outside the waiting state', () => {
    setLinks(1, [link('ready')])
    const { onStandby } = mount()
    act(() => harness.onState?.(waitingEvent('pty-exec', 'question', 'Which one?')))
    act(() => harness.onState?.(waitingEvent('pty-exec', 'permission', 'stale', 'working')))
    expect(onStandby).not.toHaveBeenCalled()
  })

  it('reads a missing summary as null', () => {
    setLinks(1, [link('ready')])
    const { onStandby } = mount()
    act(() =>
      harness.onState?.({
        sessionId: 'pty-exec',
        state: 'waiting',
        agentRunState: { state: 'waiting', blockedReason: 'permission' } as never,
      }),
    )
    expect(onStandby).toHaveBeenCalledWith(
      expect.objectContaining({ alert: { reason: 'permission', summary: null } }),
    )
  })

  it('clears the alert when the executor leaves the permission wait', () => {
    setLinks(1, [link('ready')])
    const { onStandby, onWorking } = mount()
    act(() => harness.onState?.(waitingEvent('pty-exec', 'permission', 'Run')))
    expect(onStandby).toHaveBeenCalledTimes(1)
    act(() => harness.onState?.({ sessionId: 'pty-exec', state: 'standby' }))
    expect(onWorking).toHaveBeenCalledWith('pty-exec')
  })

  it('alerts when the link health turns unavailable, and clears on recovery', () => {
    setLinks(1, [link('ready')])
    const { onStandby, onWorking } = mount()
    setLinks(2, [link('unavailable')])
    expect(onStandby).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: 'pty-exec',
        nodeId: 'exec',
        title: 'Codex executor',
        alert: { reason: 'unavailable', summary: null },
      }),
    )
    setLinks(3, [link('ready')])
    expect(onWorking).toHaveBeenCalledWith('pty-exec')
  })

  it('treats an unavailable executor present on the first read as a baseline', () => {
    const { onStandby } = mount()
    setLinks(1, [link('unavailable')])
    expect(onStandby).not.toHaveBeenCalled()
  })
})

/** The three surfaces of the alert, fed the way `useAgentStandbyNotifications` feeds them. */
describe('U-13 executor attention: end of turn does not reach the user', () => {
  const endedTurn = (id: string): WorkspaceState =>
    ({
      id: 'workspace',
      name: 'Workspace',
      path: '/workspace',
      spaces: [],
      nodes: ['exec', 'plain'].map(nodeId => ({
        id: nodeId,
        data: { kind: 'agent', sessionId: `pty-${nodeId}`, title: nodeId, status: id, agent: null },
      })),
    }) as unknown as WorkspaceState

  function mountSurfaces() {
    const cards: string[] = []
    const router = createAgentAttentionRouter<AgentStandbyNotification>({
      channels: () => ({ inApp: true, system: true, sound: true }),
      emit: effect => effect.kind === 'show-card' && cards.push(effect.item.nodeId),
    })
    const onStandby = (payload: AgentStandbyPayload) => {
      const item = { ...notification(payload.alert), ...payload, id: payload.sessionId }
      useAgentAttentionStore.setState(state => ({ notifications: [item, ...state.notifications] }))
      router.needsYou(item as AgentStandbyNotification)
    }
    renderHook(() =>
      useAgentStandbyNotificationWatcher({
        onAgentEnteredStandby: onStandby,
        onAgentEnteredWorking: vi.fn(),
      }),
    )
    const waitingNodeIds = () => {
      const needsYou = useAgentAttentionStore.getState().notifications
      const map = new Map(
        needsYou.map(item => [
          (item.alert ? executorAttentionKey : agentAttentionKey)(item.workspaceId, item.nodeId),
          item.createdAt,
        ]),
      )
      const { waiting } = summarizeAgentActivity([endedTurn('standby')], map)
      return waiting.map(reference => reference.nodeId)
    }
    return { cards, waitingNodeIds }
  }

  const endTurn = (sessionId: string) => {
    act(() => harness.onState?.({ sessionId, state: 'working' }))
    act(() => harness.onState?.({ sessionId, state: 'standby' }))
  }

  afterEach(() => {
    useAgentAttentionStore.setState(useAgentAttentionStore.getInitialState(), true)
  })

  it('keeps a linked executor out of the list, the counter and the toast', () => {
    setLinks(1, [link('ready')])
    const { cards, waitingNodeIds } = mountSurfaces()
    endTurn('pty-exec')
    expect(useAgentAttentionStore.getState().notifications).toEqual([])
    expect(waitingNodeIds()).toEqual([])
    expect(cards).toEqual([])
  })

  it('still alerts a common Agent at the end of a turn on all three', () => {
    setLinks(1, [link('ready')])
    const { cards, waitingNodeIds } = mountSurfaces()
    endTurn('pty-plain')
    expect(waitingNodeIds()).toEqual(['plain'])
    expect(cards).toEqual(['plain'])
  })

  it('still alerts the linked executor on a pending approval', () => {
    setLinks(1, [link('ready')])
    const { cards, waitingNodeIds } = mountSurfaces()
    endTurn('pty-exec')
    act(() => harness.onState?.(waitingEvent('pty-exec', 'permission', 'Run pnpm test')))
    expect(waitingNodeIds()).toEqual(['exec'])
    expect(cards).toEqual(['exec'])
  })

  it('alerts the executor again at the end of a turn once its link is gone', () => {
    const { cards } = mountSurfaces()
    endTurn('pty-exec')
    expect(cards).toEqual(['exec'])
  })
})

describe('U-11 executor attention: the router repeat', () => {
  type Item = { sessionId: string }
  function setup(repeatMs: number | null) {
    const effects: AgentAttentionEffect<Item>[] = []
    let n = 0
    const router = createAgentAttentionRouter<Item>({
      channels: () => ({ inApp: true, system: true, sound: true }),
      emit: effect => effects.push(effect),
      createId: () => `n${(n += 1)}`,
      repeatIntervalMs: () => repeatMs,
    })
    return { router, effects, kinds: () => effects.map(effect => effect.kind) }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not repeat when the interval is off', () => {
    const { router, kinds } = setup(null)
    router.needsYou({ sessionId: 'a' })
    vi.advanceTimersByTime(10 * 60_000)
    expect(kinds()).toEqual(['show-card', 'play-sound', 'system'])
  })

  it('repeats sound and system notification each interval, then stops when it is over', () => {
    const { router, effects, kinds } = setup(60_000)
    router.needsYou({ sessionId: 'a' })
    vi.advanceTimersByTime(60_000)
    expect(kinds()).toEqual(['show-card', 'play-sound', 'system', 'play-sound', 'system'])
    expect(effects[4]).toMatchObject({ kind: 'system', replacesId: null })
    vi.advanceTimersByTime(60_000)
    expect(kinds().filter(kind => kind === 'play-sound')).toHaveLength(3)
    router.working('a')
    vi.advanceTimersByTime(10 * 60_000)
    expect(kinds().filter(kind => kind === 'play-sound')).toHaveLength(3)
    expect(kinds().at(-1)).toBe('clear-card')
  })
})

function notification(alert: AgentStandbyNotification['alert']): AgentStandbyNotification {
  return {
    kind: 'agent-standby',
    id: 'pty-exec',
    sessionId: 'pty-exec',
    workspaceId: 'workspace',
    workspaceName: 'Workspace',
    workspacePath: '/workspace',
    nodeId: 'exec',
    title: 'Codex executor',
    taskId: null,
    taskTitle: null,
    spaceId: null,
    spaceName: null,
    spaceDirectoryPath: null,
    executionDirectory: '/workspace',
    gitContext: null,
    pullRequest: null,
    createdAt: 5,
    alert,
  }
}

const labels = {
  standby: 'Standby',
  task: 'Task',
  space: 'Space',
  summary: (count: number) => `${count} Agents need you`,
  permission: 'Needs approval',
  unavailable: 'Executor unavailable',
}

describe('U-11 executor attention: texts', () => {
  it('puts the executor name and the request summary in the system notification', () => {
    const text = formatAgentAttentionSystemNotification(
      [notification({ reason: 'permission', summary: 'Run pnpm test' })],
      labels,
    )
    expect(text.title).toBe('Codex executor')
    expect(text.body.split('\n').slice(0, 2)).toEqual([
      'Needs approval: Run pnpm test',
      'Workspace',
    ])
  })

  it('reads unavailable without a summary', () => {
    const text = formatAgentAttentionSystemNotification(
      [notification({ reason: 'unavailable', summary: null })],
      labels,
    )
    expect(text.body.split('\n')[0]).toBe('Executor unavailable')
  })

  it('shows the summary on the card', () => {
    render(
      createElement(AgentIslandCard, {
        notification: notification({ reason: 'permission', summary: 'Run pnpm test' }),
        live: null,
        contextVisibility: {
          showTask: true,
          showSpace: true,
          showBranch: true,
          showPullRequest: true,
        },
        layout: { y: 0, scale: 1, height: null, isTucked: false, zIndex: 1 },
        paused: true,
        onHeight: () => undefined,
        onActivate: () => undefined,
        onRetract: () => undefined,
        onDismiss: () => undefined,
      }),
    )
    expect(screen.getByTestId('app-notification-summary').textContent).toBe('Run pnpm test')
    expect(screen.getByText('Needs approval')).toBeTruthy()
  })
})

describe('U-11 executor attention: "needs you" in the sidebar and the space', () => {
  const node = (status: string) =>
    ({
      id: 'exec',
      data: { kind: 'agent', status, agent: null },
    }) as unknown as Node<TerminalNodeData>

  afterEach(() => useAgentAttentionStore.setState(useAgentAttentionStore.getInitialState(), true))

  it('keeps an executor alert in "needs you" while it is waiting or unavailable', () => {
    useAgentAttentionStore.setState({
      notifications: [notification({ reason: 'permission', summary: 'x' })],
    })
    const { result } = renderHook(() => useAgentsNeedingYou())
    expect(result.current.get(executorAttentionKey('workspace', 'exec'))).toBe(5)
    expect(resolveNeedsYouSinceMs('workspace', node('waiting'), result.current)).toBe(5)
    expect(resolveNeedsYouSinceMs('workspace', node('running'), result.current)).toBe(5)
  })

  it('still counts a common Agent only in standby', () => {
    useAgentAttentionStore.setState({ notifications: [notification(undefined)] })
    const { result } = renderHook(() => useAgentsNeedingYou())
    expect(resolveNeedsYouSinceMs('workspace', node('standby'), result.current)).toBe(5)
    expect(resolveNeedsYouSinceMs('workspace', node('waiting'), result.current)).toBeUndefined()
  })
})

describe('U-11 executor attention: settings', () => {
  it('has the repeat off by default', () => {
    expect(DEFAULT_AGENT_SETTINGS.executorAlertRepeatEnabled).toBe(false)
    expect(DEFAULT_AGENT_SETTINGS.executorAlertRepeatMinutes).toBeGreaterThan(0)
  })
})
