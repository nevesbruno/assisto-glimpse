import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TerminalNodeFrame } from '@/contexts/workspace/presentation/renderer/components/terminalNode/TerminalNodeFrame'

vi.mock('@xyflow/react', () => ({
  Handle: ({ type, position }: { type: string; position: string }) => (
    <span data-testid="handle" data-handle-type={type} data-handle-position={position} />
  ),
  Position: { Left: 'left', Right: 'right' },
}))

function renderFrame(kind: 'agent' | 'task' | 'terminal') {
  return render(
    <TerminalNodeFrame
      title="Node"
      kind={kind}
      isSelected={false}
      isDragging={false}
      status="standby"
      agentStateSource={null}
      agentHookInstallState={null}
      agentStateDegraded={false}
      lastError={null}
      recoveryIssue={null}
      sessionId="fallback-shell"
      isTerminalHydrated={true}
      transcriptRef={React.createRef<HTMLDivElement>()}
      sizeStyle={{ width: 520, height: 360 }}
      containerRef={React.createRef<HTMLDivElement>()}
      handleTerminalBodyPointerDownCapture={vi.fn()}
      handleTerminalBodyPointerMoveCapture={vi.fn()}
      handleTerminalBodyPointerUp={vi.fn()}
      consumeIgnoredTerminalBodyClick={vi.fn(() => false)}
      onClose={vi.fn()}
      find={{
        isOpen: false,
        query: '',
        resultIndex: -1,
        resultCount: 0,
        caseSensitive: false,
        useRegex: false,
      }}
      onFindQueryChange={vi.fn()}
      onFindNext={vi.fn()}
      onFindPrevious={vi.fn()}
      onFindClose={vi.fn()}
      onFindToggleCaseSensitive={vi.fn()}
      onFindToggleUseRegex={vi.fn()}
      handleResizePointerDown={vi.fn(() => vi.fn())}
    />,
  )
}

function handles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="handle"]')).map(
    element =>
      `${element.getAttribute('data-handle-type')}:${element.getAttribute('data-handle-position')}`,
  )
}

describe('TerminalNodeFrame handles', () => {
  it('gives an agent node a target and a source handle so it can orchestrate', () => {
    const { container } = renderFrame('agent')
    expect(handles(container).sort()).toEqual(['source:right', 'target:left'])
  })

  it('keeps the task node with a source handle only', () => {
    const { container } = renderFrame('task')
    expect(handles(container)).toEqual(['source:right'])
  })

  it('keeps a plain terminal node without handles', () => {
    const { container } = renderFrame('terminal')
    expect(handles(container)).toEqual([])
  })
})
