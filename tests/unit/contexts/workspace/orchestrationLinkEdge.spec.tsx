import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider, useStoreApi, Position } from '@xyflow/react'
import React, { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUiLanguage } from '@app/renderer/i18n'
import { createAppError } from '@shared/errors/appError'
import type { OrchestrationLinkDto } from '@shared/contracts/dto/orchestration'
import {
  createOrchestrationLinkSelectionStore,
  orchestrationLinkSelection,
} from '@contexts/orchestration/presentation/renderer/orchestrationLinkSelection'
import { createOrchestrationLinksStore } from '@contexts/orchestration/presentation/renderer/orchestrationLinksStore'
import { OrchestrationLinkEdge } from '../../../../src/app/renderer/shell/components/orchestration/OrchestrationLinkEdge'
import { resolveWorkspaceCanvasAgentEdges } from '@contexts/workspace/presentation/renderer/components/workspaceCanvas/hooks/useTaskAgentEdges'
import type { TerminalNodeData } from '@contexts/workspace/presentation/renderer/types'
import type { Node } from '@xyflow/react'

const LINK_ID = '11111111-1111-4111-8111-111111111111'
const DISPATCH_ID = '22222222-2222-4222-8222-222222222221'

function link(overrides: Partial<OrchestrationLinkDto> = {}): OrchestrationLinkDto {
  return {
    id: LINK_ID,
    projectId: 'p1',
    spaceId: 's1',
    orchestratorNodeId: 'orch',
    executorNodeId: 'exec',
    kind: 'executor',
    origin: 'canvas_manual',
    runtimeMode: 'service',
    provider: 'codex',
    state: 'active',
    closeReason: null,
    health: 'ready',
    roundsUsed: 1,
    roundsLimit: 10,
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
    revision: 1,
    ...overrides,
  }
}

function canvasNode(id: string, title: string): Node<TerminalNodeData> {
  return {
    id,
    position: { x: 0, y: 0 },
    data: {
      sessionId: '',
      title,
      width: 320,
      height: 240,
      kind: 'agent',
      status: 'standby',
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
    },
  }
}

const nodes = [canvasNode('orch', 'Orchestrator'), canvasNode('exec', 'Executor')]

function edgesOf(
  links: OrchestrationLinkDto[],
): ReturnType<typeof resolveWorkspaceCanvasAgentEdges> {
  return resolveWorkspaceCanvasAgentEdges({
    nodes,
    links,
    formatRoleEdgeLabel: name => name,
  })
}

describe('orchestrationLinkSelection (A-05)', () => {
  it('closes with orch.link.close once and the arrow disappears after the mirror is read again', async () => {
    const mirror: { linksRevision: number; links: OrchestrationLinkDto[] } = {
      linksRevision: 1,
      links: [link()],
    }
    const linksStore = createOrchestrationLinksStore({ readMirror: async () => mirror })
    await linksStore.refresh()
    expect(edgesOf(linksStore.store.getState().links)).toHaveLength(1)

    const calls: { linkId: string; force: boolean }[] = []
    const selection = createOrchestrationLinkSelectionStore({
      closeLink: async input => {
        calls.push(input)
        mirror.links = []
        mirror.linksRevision = 2
      },
      refreshMirror: () => linksStore.refresh({ force: true }),
    })

    selection.select(LINK_ID)
    selection.requestClose(LINK_ID)
    await act(async () => {
      await selection.confirmClose()
    })

    expect(calls).toEqual([{ linkId: LINK_ID, force: false }])
    expect(linksStore.store.getState().links).toEqual([])
    expect(edgesOf(linksStore.store.getState().links)).toHaveLength(0)
    expect(selection.store.getState()).toMatchObject({
      selectedLinkId: null,
      closingLinkId: null,
      inFlight: false,
      errorCode: null,
    })
  })

  it('a cancel runs nothing', () => {
    const closeLink = vi.fn(async () => undefined)
    const selection = createOrchestrationLinkSelectionStore({
      closeLink,
      refreshMirror: async () => undefined,
    })
    selection.requestClose(LINK_ID)
    selection.cancelClose()
    expect(closeLink).not.toHaveBeenCalled()
    expect(selection.store.getState().closingLinkId).toBeNull()
  })
})

describe('orchestrationLinkSelection with a dispatch in flight (A-06)', () => {
  it('asks for force only after orch.dispatch_in_flight and sends force on the second call', async () => {
    const calls: boolean[] = []
    const selection = createOrchestrationLinkSelectionStore({
      closeLink: async ({ force }) => {
        calls.push(force)
        if (!force) {
          throw createAppError('orch.dispatch_in_flight', {
            details: { dispatchId: DISPATCH_ID, state: 'sent', round: 1 },
          })
        }
      },
      refreshMirror: async () => undefined,
    })

    selection.requestClose(LINK_ID)
    await act(async () => {
      await selection.confirmClose()
    })
    expect(calls).toEqual([false])
    expect(selection.store.getState()).toMatchObject({
      phase: 'force',
      inFlight: false,
      blocking: { state: 'sent', round: 1 },
      errorCode: null,
    })

    await act(async () => {
      await selection.forceClose()
    })
    expect(calls).toEqual([false, true])
    expect(selection.store.getState()).toMatchObject({
      closingLinkId: null,
      selectedLinkId: null,
    })
  })

  it('keeps the popover open with the error line for any other failure', async () => {
    const selection = createOrchestrationLinkSelectionStore({
      closeLink: async () => {
        throw createAppError('orch.forbidden')
      },
      refreshMirror: async () => undefined,
    })
    selection.requestClose(LINK_ID)
    await act(async () => {
      await selection.confirmClose()
    })
    expect(selection.store.getState()).toMatchObject({
      closingLinkId: LINK_ID,
      phase: 'confirm',
      inFlight: false,
      errorCode: 'orch.forbidden',
      blocking: null,
    })
  })
})

const EDGE = edgesOf([link()])[0]

function Harness({ selected }: { selected: boolean }) {
  const store = useStoreApi()
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    store.setState({ domNode: ref.current } as unknown as Parameters<typeof store.setState>[0])
  }, [store])
  return (
    <div ref={ref}>
      <div className="react-flow__edgelabel-renderer" />
      <svg>
        <OrchestrationLinkEdge
          id={EDGE.id}
          type={EDGE.type}
          source="orch"
          target="exec"
          selectable
          deletable
          selected={selected}
          data={EDGE.data}
          sourceX={0}
          sourceY={0}
          targetX={200}
          targetY={100}
          sourcePosition={Position.Right}
          targetPosition={Position.Left}
        />
      </svg>
    </div>
  )
}

describe('OrchestrationLinkEdge label (A-04, A-06)', () => {
  beforeEach(async () => {
    await applyUiLanguage('en')
    orchestrationLinkSelection.select(null)
    orchestrationLinkSelection.cancelClose()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('Delete after the label opens the popover never closes the link', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('opencoveApi', { controlSurface: { invoke } })
    orchestrationLinkSelection.select(LINK_ID)
    render(
      <ReactFlowProvider>
        <Harness selected />
      </ReactFlowProvider>,
    )

    fireEvent.click(screen.getByTestId(`orchestration-link-close-${LINK_ID}`))
    expect(screen.getByTestId(`orchestration-link-close-confirm-${LINK_ID}`)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId(`orchestration-link-close-popover-${LINK_ID}`), {
      key: 'Delete',
    })
    expect(invoke).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByTestId(`orchestration-link-close-popover-${LINK_ID}`), {
      key: 'Escape',
    })
    expect(screen.queryByTestId(`orchestration-link-close-popover-${LINK_ID}`)).toBeNull()
  })

  it('shows the force button after dispatch_in_flight and sends force on the second click', async () => {
    const calls: unknown[] = []
    const invoke = vi.fn(async (request: { payload: { force: boolean } }) => {
      calls.push(request.payload)
      if (!request.payload.force) {
        throw createAppError('orch.dispatch_in_flight', {
          details: { dispatchId: DISPATCH_ID, state: 'sent', round: 1 },
        })
      }
      return { ok: true }
    })
    vi.stubGlobal('opencoveApi', { controlSurface: { invoke } })
    orchestrationLinkSelection.select(LINK_ID)
    render(
      <ReactFlowProvider>
        <Harness selected />
      </ReactFlowProvider>,
    )

    fireEvent.click(screen.getByTestId(`orchestration-link-close-${LINK_ID}`))
    expect(screen.getByTestId(`orchestration-link-close-confirm-${LINK_ID}`)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`orchestration-link-close-confirm-${LINK_ID}`))

    await waitFor(() =>
      expect(screen.getByTestId(`orchestration-link-close-force-${LINK_ID}`)).toBeInTheDocument(),
    )
    expect(screen.getByText(/round r1\/10/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`orchestration-link-close-force-${LINK_ID}`))
    await waitFor(() =>
      expect(calls).toEqual([
        { linkId: LINK_ID, force: false },
        { linkId: LINK_ID, force: true },
      ]),
    )
    await waitFor(() =>
      expect(screen.queryByTestId(`orchestration-link-close-popover-${LINK_ID}`)).toBeNull(),
    )
  })
})
