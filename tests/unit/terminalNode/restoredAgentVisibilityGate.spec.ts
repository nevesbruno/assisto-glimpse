import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRestoredAgentVisibilityGate } from '../../../src/contexts/workspace/presentation/renderer/components/terminalNode/restoredAgentVisibilityGate'

function createTerminal(hasContent: () => boolean): Terminal {
  return {
    buffer: {
      active: {
        length: 1,
        getLine: () => ({
          translateToString: () => (hasContent() ? 'ready' : ''),
        }),
      },
    },
  } as unknown as Terminal
}

function createGate(terminal: Terminal) {
  const calls = {
    markHydrated: vi.fn(),
    protectVisibleBaseline: vi.fn(),
    scheduleTranscriptSync: vi.fn(),
    reportThemeMode: vi.fn(),
    releaseBufferedUserInput: vi.fn(),
    log: vi.fn(),
  }
  const gate = createRestoredAgentVisibilityGate({
    terminal,
    shouldAwaitAgentVisibleOutput: true,
    shouldGateInitialUserInput: true,
    isDisposed: () => false,
    ...calls,
  })
  return { gate, calls }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('restored agent visibility gate timeout', () => {
  it('reveals after three seconds without visible output and records the timeout reason', () => {
    const { gate, calls } = createGate(createTerminal(() => false))

    gate.revealAfterHydration()

    expect(calls.markHydrated).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2_999)
    expect(calls.markHydrated).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)

    expect(calls.markHydrated).toHaveBeenCalledTimes(1)
    expect(calls.releaseBufferedUserInput).toHaveBeenCalledTimes(1)
    expect(calls.protectVisibleBaseline).toHaveBeenCalled()
    expect(calls.log).toHaveBeenCalledWith('agent-visible-output-ready', { reason: 'timeout' })
  })

  it('reveals on visible output before the timeout and never logs a timeout', () => {
    let hasContent = false
    const { gate, calls } = createGate(createTerminal(() => hasContent))

    gate.revealAfterHydration()
    hasContent = true
    gate.notifyWriteCommitted('ready\n')

    expect(calls.markHydrated).toHaveBeenCalledTimes(1)
    expect(calls.log).toHaveBeenCalledWith('agent-visible-output-ready', {
      reason: 'visible_output',
    })

    vi.advanceTimersByTime(3_000)

    expect(calls.markHydrated).toHaveBeenCalledTimes(1)
    expect(calls.log).not.toHaveBeenCalledWith('agent-visible-output-ready', { reason: 'timeout' })
  })
})
