import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppError } from '../../../../src/shared/errors/appError'
import {
  attentionItemCount,
  createOrchestrationAttentionStore,
  type OrchestrationAttentionClient,
} from '../../../../src/contexts/orchestration/presentation/renderer/orchestrationAttentionStore'
import type { OrchestrationAttentionResult } from '../../../../src/shared/contracts/dto/orchestrationAttention'

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

const withItems = (): OrchestrationAttentionResult => ({
  linksRevision: 3,
  links: [{ executorNodeId: 'exec-1', approvals: [approval], hooks: [hook] }],
})
const empty = (): OrchestrationAttentionResult => ({ linksRevision: 4, links: [] })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function clientWith(list: OrchestrationAttentionClient['list']): OrchestrationAttentionClient {
  return {
    list,
    respondApproval: vi.fn(async () => ({ ok: true })),
    approveHooks: vi.fn(async () => ({ approved: 1, restart: 'done' as const })),
  }
}

describe('orchestrationAttentionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads the list and counts approvals and hooks together', async () => {
    const client = clientWith(vi.fn(async () => withItems()))
    const handle = createOrchestrationAttentionStore(client)

    await handle.refresh()

    expect(handle.store.getState()).toMatchObject({
      linksRevision: 3,
      links: withItems().links,
      errorCode: null,
      inFlight: [],
    })
    expect(attentionItemCount(handle.store.getState().links)).toBe(2)
  })

  it('keeps the last good list when the read fails, and reports the reason', async () => {
    const list = vi
      .fn<OrchestrationAttentionClient['list']>()
      .mockResolvedValueOnce(withItems())
      .mockRejectedValueOnce(createAppError('common.unavailable'))
    const handle = createOrchestrationAttentionStore(clientWith(list))

    await handle.refresh()
    await handle.refresh()

    expect(handle.store.getState().links).toHaveLength(1)
    expect(handle.store.getState().errorCode).toBe('common.unavailable')
  })

  it('repeats the read once when a link event arrives while the list is being read', async () => {
    const first = deferred<OrchestrationAttentionResult>()
    const list = vi
      .fn<OrchestrationAttentionClient['list']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(empty())
    const handle = createOrchestrationAttentionStore(clientWith(list))

    const reading = handle.refresh()
    handle.handleSyncEvent({
      type: 'orchestration.links.updated',
      revision: 5,
      linksRevision: 4,
      operationId: 'op-1',
    })
    first.resolve(withItems())
    await reading

    expect(list).toHaveBeenCalledTimes(2)
    expect(handle.store.getState().links).toEqual([])
  })

  it('sends one approval call per item, re-reads, and only then the item disappears', async () => {
    const respond = deferred<unknown>()
    const list = vi
      .fn<OrchestrationAttentionClient['list']>()
      .mockResolvedValueOnce(withItems())
      .mockResolvedValueOnce(empty())
    const client = clientWith(list)
    client.respondApproval = vi.fn(() => respond.promise)
    const handle = createOrchestrationAttentionStore(client)
    await handle.refresh()

    const first = handle.respondApproval({
      executorNodeId: 'exec-1',
      requestId: 'req-1',
      decision: 'accept',
    })
    const second = handle.respondApproval({
      executorNodeId: 'exec-1',
      requestId: 'req-1',
      decision: 'accept',
    })
    expect(handle.store.getState().inFlight).toEqual(['approval:exec-1:req-1'])
    expect(handle.store.getState().links).toHaveLength(1)

    respond.resolve({ ok: true })
    await Promise.all([first, second])

    expect(client.respondApproval).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(2)
    expect(handle.store.getState().links).toEqual([])
    expect(handle.store.getState().inFlight).toEqual([])
  })

  it('treats approval_not_found as already answered: re-reads and notifies', async () => {
    const list = vi
      .fn<OrchestrationAttentionClient['list']>()
      .mockResolvedValueOnce(withItems())
      .mockResolvedValueOnce(empty())
    const client = clientWith(list)
    client.respondApproval = vi.fn(async () =>
      Promise.reject(createAppError('orch.approval_not_found')),
    )
    const handle = createOrchestrationAttentionStore(client)
    await handle.refresh()

    await handle.respondApproval({
      executorNodeId: 'exec-1',
      requestId: 'req-1',
      decision: 'accept',
    })

    expect(handle.store.getState().links).toEqual([])
    expect(handle.store.getState().notice).toEqual({ kind: 'approval_already_answered' })
  })

  it('keeps the item when the executor is unavailable and records the action error', async () => {
    const client = clientWith(vi.fn(async () => withItems()))
    client.respondApproval = vi.fn(async () =>
      Promise.reject(createAppError('orch.executor_unavailable')),
    )
    const handle = createOrchestrationAttentionStore(client)
    await handle.refresh()

    await handle.respondApproval({
      executorNodeId: 'exec-1',
      requestId: 'req-1',
      decision: 'accept',
    })

    expect(handle.store.getState().links).toHaveLength(1)
    expect(handle.store.getState().actionErrorCode).toBe('orch.executor_unavailable')
  })

  it('closes the surface on orch.not_linked', async () => {
    const client = clientWith(vi.fn(async () => withItems()))
    client.approveHooks = vi.fn(async () => Promise.reject(createAppError('orch.not_linked')))
    const handle = createOrchestrationAttentionStore(client)
    await handle.refresh()

    await handle.approveHook({ executorNodeId: 'exec-1', key: 'k1' })

    expect(handle.store.getState().closedCode).toBe('orch.not_linked')
  })

  it('approves one hook by key, announces a scheduled restart and re-reads', async () => {
    const list = vi
      .fn<OrchestrationAttentionClient['list']>()
      .mockResolvedValueOnce(withItems())
      .mockResolvedValueOnce(empty())
    const client = clientWith(list)
    client.approveHooks = vi.fn(async () => ({ approved: 1, restart: 'scheduled' as const }))
    const handle = createOrchestrationAttentionStore(client)
    await handle.refresh()

    await handle.approveHook({ executorNodeId: 'exec-1', key: 'k1' })

    expect(client.approveHooks).toHaveBeenCalledWith({ executorNodeId: 'exec-1', keys: ['k1'] })
    expect(handle.store.getState().links).toEqual([])
    expect(handle.store.getState().notice).toEqual({ kind: 'hook_restart_scheduled' })
  })

  it('treats a refused hook key as changed: re-reads and notifies', async () => {
    const list = vi
      .fn<OrchestrationAttentionClient['list']>()
      .mockResolvedValueOnce(withItems())
      .mockResolvedValueOnce(empty())
    const client = clientWith(list)
    client.approveHooks = vi.fn(async () => Promise.reject(createAppError('common.invalid_input')))
    const handle = createOrchestrationAttentionStore(client)
    await handle.refresh()

    await handle.approveHook({ executorNodeId: 'exec-1', key: 'k1' })

    expect(list).toHaveBeenCalledTimes(2)
    expect(handle.store.getState().notice).toEqual({ kind: 'hook_changed' })
  })

  it('ignores unrelated sync events and resets every field', async () => {
    const list = vi.fn(async () => withItems())
    const handle = createOrchestrationAttentionStore(clientWith(list))
    await handle.refresh()
    handle.dismissNotice()

    handle.handleSyncEvent({ type: 'canvas.focus' } as never)
    expect(list).toHaveBeenCalledTimes(1)

    handle.reset()
    expect(handle.store.getState()).toMatchObject({
      linksRevision: 0,
      links: [],
      errorCode: null,
      closedCode: null,
      notice: null,
      inFlight: [],
    })
  })
})
