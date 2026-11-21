import React from 'react'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import type { FinalConnectionState, Node } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUiLanguage } from '@app/renderer/i18n'
import { createAppError } from '@shared/errors/appError'
import { useOrchestrationConnect } from '@contexts/workspace/presentation/renderer/components/workspaceCanvas/hooks/useOrchestrationConnect'
import { OrchestrationConnectPrompt } from '../../../../src/app/renderer/shell/components/orchestration/OrchestrationConnectPrompt'
import type { TerminalNodeData } from '@contexts/workspace/presentation/renderer/types'

function node(id: string, provider: string, title: string): Node<TerminalNodeData> {
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
      agent: {
        provider: provider as never,
        prompt: '',
        model: null,
        effectiveModel: null,
        launchMode: 'new',
        resumeSessionId: null,
        executionDirectory: '',
        expectedDirectory: null,
        directoryMode: 'workspace',
        customDirectory: null,
        shouldCreateDirectory: false,
        taskId: null,
      },
      task: null,
      note: null,
      role: null,
      image: null,
      document: null,
      website: null,
    },
  }
}

const NODES = [
  node('orch', 'claude-code', 'Orchestrator'),
  node('exec', 'codex', 'Executor'),
  node('claude-2', 'claude-code', 'Second orchestrator'),
]

const endState = (from: string | null, to: string | null): FinalConnectionState =>
  ({
    isValid: false,
    fromNode: from ? { id: from } : null,
    toNode: to ? { id: to } : null,
  }) as unknown as FinalConnectionState

const CONNECT_INPUT = { projectId: 'p1', nodes: NODES, links: [] } as const

describe('useOrchestrationConnect (A-02)', () => {
  beforeEach(async () => {
    await applyUiLanguage('en')
  })
  afterEach(cleanup)

  it('opens the confirmation on a valid drag and only calls orch.link.create on accept', async () => {
    const invoke = vi.fn(async () => ({ linkId: 'link-1' }))
    const { result } = renderHook(() => useOrchestrationConnect({ ...CONNECT_INPUT, invoke }))
    expect(result.current.isValidConnection({ source: 'orch', target: 'exec' } as never)).toBe(true)

    act(() => {
      result.current.onConnect({ source: 'orch', target: 'exec' } as never)
    })
    expect(result.current.prompt.confirmation).toMatchObject({
      sourceTitle: 'Orchestrator',
      targetTitle: 'Executor',
      busy: false,
      reattach: false,
      inFlight: false,
      errorCode: null,
    })
    expect(invoke).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.accept()
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith({
      kind: 'command',
      id: 'orch.link.create',
      payload: { orchestratorNodeId: 'orch', executorNodeId: 'exec' },
    })
    expect(result.current.prompt.confirmation).toBeNull()
  })

  it('cancel closes the confirmation without any call', () => {
    const invoke = vi.fn(async () => ({ linkId: 'link-1' }))
    const { result } = renderHook(() => useOrchestrationConnect({ ...CONNECT_INPUT, invoke }))
    act(() => {
      result.current.onConnect({ source: 'orch', target: 'exec' } as never)
    })
    act(() => result.current.cancel())
    expect(result.current.prompt.confirmation).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps the confirmation open with the error code when the Worker refuses', async () => {
    const invoke = vi.fn(async () => {
      throw createAppError('orch.link_invalid')
    })
    const { result } = renderHook(() => useOrchestrationConnect({ ...CONNECT_INPUT, invoke }))
    act(() => {
      result.current.onConnect({ source: 'orch', target: 'exec' } as never)
    })
    await act(async () => {
      await result.current.accept()
    })
    expect(result.current.prompt.confirmation).toMatchObject({
      inFlight: false,
      errorCode: 'orch.link_invalid',
    })
  })
})

describe('useOrchestrationConnect invalid drag (A-03)', () => {
  beforeEach(async () => {
    await applyUiLanguage('en')
  })
  afterEach(cleanup)

  function renderPrompt(
    result: ReturnType<typeof useOrchestrationConnect>,
    invoke: ReturnType<typeof vi.fn>,
  ) {
    render(
      <OrchestrationConnectPrompt
        prompt={result.prompt}
        onAccept={() => {
          void result.accept()
        }}
        onCancel={result.cancel}
      />,
    )
    expect(invoke).not.toHaveBeenCalled()
  }

  it('a claude-code target gives the peer hint and calls nothing', () => {
    const invoke = vi.fn(async () => ({}))
    const { result } = renderHook(() => useOrchestrationConnect({ ...CONNECT_INPUT, invoke }))
    expect(result.current.isValidConnection({ source: 'orch', target: 'claude-2' } as never)).toBe(
      false,
    )
    act(() => {
      result.current.onConnectEnd({} as MouseEvent, endState('orch', 'claude-2'))
    })
    expect(result.current.prompt.hintKey).toBe('orchestration.connect.hint.peerPending')
    renderPrompt(result.current, invoke)
    const hint = screen.getByTestId('orchestration-connect-hint')
    expect(hint).toHaveAttribute('data-hint-key', 'orchestration.connect.hint.peerPending')
    expect(hint).toHaveTextContent('This release links only codex or opencode sessions.')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('a release without a target asks for the executing session', () => {
    const invoke = vi.fn(async () => ({}))
    const { result } = renderHook(() => useOrchestrationConnect({ ...CONNECT_INPUT, invoke }))
    act(() => {
      result.current.onConnectEnd({} as MouseEvent, endState('orch', null))
    })
    expect(result.current.prompt.hintKey).toBe('orchestration.connect.hint.dropOnExecutor')
    renderPrompt(result.current, invoke)
  })

  it('a non claude-code origin gives the origin hint', () => {
    const invoke = vi.fn(async () => ({}))
    const { result } = renderHook(() => useOrchestrationConnect({ ...CONNECT_INPUT, invoke }))
    expect(result.current.isValidConnection({ source: 'exec', target: 'orch' } as never)).toBe(
      false,
    )
    act(() => {
      result.current.onConnectEnd({} as MouseEvent, endState('exec', 'orch'))
    })
    expect(result.current.prompt.hintKey).toBe('orchestration.connect.hint.sourceNotOrchestrator')
  })
})
