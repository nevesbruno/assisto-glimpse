import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUiLanguage } from '@app/renderer/i18n'
import { createAppError } from '@shared/errors/appError'
import type { OrchestrationAttentionResult } from '@shared/contracts/dto/orchestrationAttention'
import { orchestrationAttention } from '@contexts/orchestration/presentation/renderer/orchestrationAttentionStore'
import { OrchestrationApprovalsWindow } from './OrchestrationApprovalsWindow'

const approval = {
  requestId: 'req-1',
  kind: 'command',
  summary: 'rm -rf build',
  turnRef: 'turn-1',
}
const hook = {
  key: 'k1',
  event: 'PreToolUse',
  origin: '/home/u/hook.sh',
  currentHash: 'hash-1',
}

const withApproval = (): OrchestrationAttentionResult => ({
  linksRevision: 3,
  links: [{ executorNodeId: 'exec-1', approvals: [approval], hooks: [] }],
})
const withHook = (): OrchestrationAttentionResult => ({
  linksRevision: 3,
  links: [{ executorNodeId: 'exec-1', approvals: [], hooks: [hook] }],
})
/** The link stays; only its items are gone. An absent link means the window must close. */
const empty = (): OrchestrationAttentionResult => ({
  linksRevision: 4,
  links: [{ executorNodeId: 'exec-1', approvals: [], hooks: [] }],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderWindow(onClose = vi.fn()) {
  return render(<OrchestrationApprovalsWindow isOpen executorNodeId="exec-1" onClose={onClose} />)
}

const STORAGE_KEY = 'opencove:m0:workspace-state'

/** The links mirror is read from the localStorage port in this environment. */
function seedLinksMirror(health: 'starting' | 'ready' | 'busy' | 'degraded' | 'unavailable'): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      orchestrationLinks: {
        linksRevision: 1,
        links: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            projectId: 'p1',
            spaceId: 's1',
            orchestratorNodeId: 'orch',
            executorNodeId: 'exec-1',
            kind: 'executor',
            origin: 'orchestrator_spawn',
            runtimeMode: 'service',
            provider: 'codex',
            state: 'active',
            closeReason: null,
            health,
            roundsUsed: 0,
            roundsLimit: 10,
            createdAt: '2026-11-09T00:00:00.000Z',
            updatedAt: '2026-11-09T00:00:00.000Z',
            revision: 1,
          },
        ],
      },
    }),
  )
}

describe('OrchestrationApprovalsWindow', () => {
  const invoke = vi.fn()

  beforeEach(async () => {
    await applyUiLanguage('en')
    localStorage.clear()
    // The links store is a module singleton: give every test a fresh ready mirror.
    seedLinksMirror('ready')
    orchestrationAttention.reset()
    invoke.mockReset()
    vi.stubGlobal('opencoveApi', { controlSurface: { invoke } })
  })

  afterEach(() => {
    cleanup()
    orchestrationAttention.reset()
    vi.unstubAllGlobals()
  })

  it('shows the summary and keeps the item until a read confirms the answer', async () => {
    const secondRead = deferred<OrchestrationAttentionResult>()
    invoke.mockImplementation(async request => {
      if (request.id === 'orch.approval.list') {
        return invoke.mock.calls.filter(call => call[0].id === 'orch.approval.list').length === 1
          ? withApproval()
          : secondRead.promise
      }
      if (request.id === 'orch.approval.respond') {
        return { ok: true }
      }
      throw new Error(`unexpected ${request.id}`)
    })

    renderWindow()
    expect(await screen.findByText('rm -rf build')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('orchestration-approval-accept-req-1'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'command',
          id: 'orch.approval.respond',
          payload: { executorNodeId: 'exec-1', requestId: 'req-1', decision: 'accept' },
        }),
      ),
    )
    // The action returned, but the item is still there: no optimistic removal.
    expect(screen.getByText('rm -rf build')).toBeInTheDocument()

    await act(async () => {
      secondRead.resolve(empty())
      await secondRead.promise
    })
    await waitFor(() => expect(screen.queryByText('rm -rf build')).toBeNull())
  })

  it('sends one request when the approve button is clicked twice while the answer is in flight', async () => {
    const response = deferred<unknown>()
    invoke.mockImplementation(async request => {
      if (request.id === 'orch.approval.list') {
        return invoke.mock.calls.filter(call => call[0].id === 'orch.approval.list').length === 1
          ? withApproval()
          : empty()
      }
      if (request.id === 'orch.approval.respond') {
        return response.promise
      }
      throw new Error(`unexpected ${request.id}`)
    })

    renderWindow()
    await screen.findByText('rm -rf build')

    const button = screen.getByTestId('orchestration-approval-accept-req-1')
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(button).toBeDisabled())

    response.resolve({ ok: true })
    await act(async () => {
      await response.promise
    })
    await waitFor(() =>
      expect(screen.queryByTestId('orchestration-approval-accept-req-1')).toBeNull(),
    )

    const answerCalls = invoke.mock.calls.filter(call => call[0].id === 'orch.approval.respond')
    expect(answerCalls).toHaveLength(1)
  })

  it('shows "already answered" after orch.approval_not_found and re-reads the list', async () => {
    invoke.mockImplementation(async request => {
      if (request.id === 'orch.approval.list') {
        return invoke.mock.calls.filter(call => call[0].id === 'orch.approval.list').length === 1
          ? withApproval()
          : empty()
      }
      if (request.id === 'orch.approval.respond') {
        throw createAppError('orch.approval_not_found')
      }
      throw new Error(`unexpected ${request.id}`)
    })

    renderWindow()
    await screen.findByText('rm -rf build')

    fireEvent.click(screen.getByTestId('orchestration-approval-accept-req-1'))

    expect(await screen.findByText('Already answered on the executor screen.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('rm -rf build')).toBeNull())
    expect(invoke.mock.calls.filter(call => call[0].id === 'orch.approval.list')).toHaveLength(2)
  })

  it('approves one hook by key and shows the scheduled restart', async () => {
    invoke.mockImplementation(async request => {
      if (request.id === 'orch.approval.list') {
        return invoke.mock.calls.filter(call => call[0].id === 'orch.approval.list').length === 1
          ? withHook()
          : empty()
      }
      if (request.id === 'orch.hooks.approve') {
        return { approved: 1, restart: 'scheduled' }
      }
      throw new Error(`unexpected ${request.id}`)
    })

    renderWindow()
    expect(await screen.findByText('Hook waiting for trust')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('orchestration-hook-approve'))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith({
        kind: 'command',
        id: 'orch.hooks.approve',
        payload: { executorNodeId: 'exec-1', keys: ['k1'] },
      }),
    )
    expect(
      await screen.findByText('Hook approved. The executor restarts when it is idle.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Hook waiting for trust')).toBeNull())
  })

  it('keeps the actions enabled while the executor is busy and sends the answer', async () => {
    seedLinksMirror('busy')
    invoke.mockImplementation(async request => {
      if (request.id === 'orch.approval.list') {
        return invoke.mock.calls.filter(call => call[0].id === 'orch.approval.list').length === 1
          ? withApproval()
          : empty()
      }
      if (request.id === 'orch.approval.respond') {
        return { ok: true }
      }
      throw new Error(`unexpected ${request.id}`)
    })

    renderWindow()
    await screen.findByText('rm -rf build')

    const button = screen.getByTestId('orchestration-approval-accept-req-1')
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith({
        kind: 'command',
        id: 'orch.approval.respond',
        payload: { executorNodeId: 'exec-1', requestId: 'req-1', decision: 'accept' },
      }),
    )
  })

  it('keeps the actions disabled while the executor is unavailable', async () => {
    seedLinksMirror('unavailable')
    invoke.mockImplementation(async request => {
      if (request.id === 'orch.approval.list') {
        return withApproval()
      }
      if (request.id === 'orch.approval.respond') {
        return { ok: true }
      }
      throw new Error(`unexpected ${request.id}`)
    })

    renderWindow()
    await screen.findByText('rm -rf build')

    const button = screen.getByTestId('orchestration-approval-accept-req-1')
    await waitFor(() => expect(button).toBeDisabled())
    fireEvent.click(button)

    expect(invoke.mock.calls.filter(call => call[0].id === 'orch.approval.respond')).toHaveLength(0)
  })

  it('closes the window when a read no longer returns the linked executor', async () => {
    const onClose = vi.fn()
    let read: OrchestrationAttentionResult = withApproval()
    invoke.mockImplementation(async request => {
      if (request.id === 'orch.approval.list') {
        return read
      }
      throw new Error(`unexpected ${request.id}`)
    })

    renderWindow(onClose)
    await screen.findByText('rm -rf build')

    read = { linksRevision: 5, links: [] }
    await act(async () => {
      await orchestrationAttention.refresh()
    })

    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('closes the window when the worker says the link is gone', async () => {
    const onClose = vi.fn()
    invoke.mockImplementation(async request => {
      if (request.id === 'orch.approval.list') {
        return withApproval()
      }
      if (request.id === 'orch.approval.respond') {
        throw createAppError('orch.not_linked')
      }
      throw new Error(`unexpected ${request.id}`)
    })

    renderWindow(onClose)
    await screen.findByText('rm -rf build')
    fireEvent.click(screen.getByTestId('orchestration-approval-accept-req-1'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
