import type { Terminal } from '@xterm/xterm'
import type { TerminalDiagnosticsLogInput } from '@shared/contracts/dto'
import { hasVisibleTerminalBufferContent } from './terminalRuntimeDiagnostics'
import { createRestoredAgentVisibleOutputObserver } from './useTerminalRuntimeSession.support'

type RevealReason = 'hydration_revealed' | 'visible_output' | 'timeout'

const RESTORED_AGENT_REVEAL_TIMEOUT_MS = 3_000

export function createRestoredAgentVisibilityGate({
  terminal,
  shouldAwaitAgentVisibleOutput,
  shouldGateInitialUserInput,
  isDisposed,
  markHydrated,
  protectVisibleBaseline,
  scheduleTranscriptSync,
  reportThemeMode,
  releaseBufferedUserInput,
  log,
}: {
  terminal: Terminal
  shouldAwaitAgentVisibleOutput: boolean
  shouldGateInitialUserInput: boolean
  isDisposed: () => boolean
  markHydrated: () => void
  protectVisibleBaseline: () => void
  scheduleTranscriptSync: () => void
  reportThemeMode: () => void
  releaseBufferedUserInput: () => void
  log: (event: string, details?: TerminalDiagnosticsLogInput['details']) => void
}) {
  let isAwaitingAgentVisibleOutput = false
  let revealTimeoutHandle: number | null = null
  const hasVisibleOutput = () => hasVisibleTerminalBufferContent(terminal)
  const clearRevealTimeout = (): void => {
    if (revealTimeoutHandle === null) {
      return
    }

    window.clearTimeout(revealTimeoutHandle)
    revealTimeoutHandle = null
  }
  const scheduleRevealTimeout = (): void => {
    clearRevealTimeout()
    revealTimeoutHandle = window.setTimeout(() => {
      revealTimeoutHandle = null
      if (isAwaitingAgentVisibleOutput) {
        revealRuntimeTerminal('timeout')
      }
    }, RESTORED_AGENT_REVEAL_TIMEOUT_MS)
  }
  const revealRuntimeTerminal = (reason: RevealReason): void => {
    if (isDisposed()) {
      return
    }

    const wasAwaitingAgentVisibleOutput = isAwaitingAgentVisibleOutput
    isAwaitingAgentVisibleOutput = false
    clearRevealTimeout()
    visibleOutputObserver.stopWaiting()
    if (shouldAwaitAgentVisibleOutput) {
      protectVisibleBaseline()
    }
    markHydrated()
    scheduleTranscriptSync()
    reportThemeMode()
    if (wasAwaitingAgentVisibleOutput || reason !== 'hydration_revealed') {
      log('agent-visible-output-ready', { reason })
    }
    if (shouldGateInitialUserInput) {
      releaseBufferedUserInput()
    }
  }
  const visibleOutputObserver = createRestoredAgentVisibleOutputObserver({
    hasVisibleOutput,
    onReady: () => {
      revealRuntimeTerminal('visible_output')
    },
  })

  return {
    revealAfterHydration: () => {
      if (isDisposed()) {
        return
      }

      if (shouldAwaitAgentVisibleOutput && !hasVisibleOutput()) {
        isAwaitingAgentVisibleOutput = true
        visibleOutputObserver.beginWaiting()
        scheduleRevealTimeout()
        scheduleTranscriptSync()
        reportThemeMode()
        log('agent-visible-output-wait', { reason: 'empty_hydration_baseline' })
        return
      }

      revealRuntimeTerminal('hydration_revealed')
    },
    notifyOutputObserved: (data: string) => {
      visibleOutputObserver.notifyOutputObserved(data)
    },
    notifyWriteCommitted: (data?: string) => {
      if (isAwaitingAgentVisibleOutput) {
        visibleOutputObserver.notifyWriteCommitted(data)
      }
    },
    notifyReplayWriteCommitted: () => {
      scheduleTranscriptSync()
      if (isAwaitingAgentVisibleOutput) {
        visibleOutputObserver.notifyWriteCommitted()
      }
    },
    dispose: () => {
      clearRevealTimeout()
      visibleOutputObserver.dispose()
    },
  }
}
