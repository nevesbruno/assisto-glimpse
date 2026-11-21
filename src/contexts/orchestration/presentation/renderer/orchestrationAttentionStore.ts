import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  orchestrationAttentionResultSchema,
  type OrchestrationAttentionLinkDto,
  type OrchestrationAttentionResult,
} from '@shared/contracts/dto/orchestrationAttention'
import type { OrchestrationHooksApproveResult } from '@shared/contracts/dto/orchestration'
import type { SyncEventPayload } from '@shared/contracts/dto'
import { createAppError } from '@shared/errors/appError'

export type OrchestrationApprovalAnswer = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export type OrchestrationAttentionNotice =
  | { readonly kind: 'approval_already_answered' }
  | { readonly kind: 'hook_changed' }
  | { readonly kind: 'hook_restart_scheduled' }

export interface OrchestrationAttentionClient {
  /** The Worker read; the only source of the list the window shows. */
  list: () => Promise<OrchestrationAttentionResult>
  respondApproval: (input: {
    executorNodeId: string
    requestId: string
    decision: OrchestrationApprovalAnswer
  }) => Promise<unknown>
  approveHooks: (input: {
    executorNodeId: string
    keys: string[]
  }) => Promise<OrchestrationHooksApproveResult>
}

export interface OrchestrationAttentionState {
  linksRevision: number
  links: OrchestrationAttentionLinkDto[]
  /** At least one good read happened; an empty list then means "nothing pending", not "not read". */
  loaded: boolean
  /** Code of a failed read; the section stays disabled with the reason until a good read. */
  errorCode: string | null
  /** Code that ended the surface for this call, such as `orch.not_linked`. */
  closedCode: 'orch.forbidden' | 'orch.not_linked' | null
  /** Code of the last action that kept the item, shown beside it. */
  actionErrorCode: string | null
  notice: OrchestrationAttentionNotice | null
  /** One request in flight per item; the button stays disabled meanwhile. */
  inFlight: string[]
}

export interface OrchestrationAttentionStore {
  store: StoreApi<OrchestrationAttentionState>
  refresh: () => Promise<void>
  handleSyncEvent: (event: SyncEventPayload) => void
  respondApproval: (input: {
    executorNodeId: string
    requestId: string
    decision: OrchestrationApprovalAnswer
  }) => Promise<void>
  approveHook: (input: { executorNodeId: string; key: string }) => Promise<void>
  dismissNotice: () => void
  reset: () => void
}

const EMPTY_LINKS: OrchestrationAttentionLinkDto[] = []

export function approvalItemKey(executorNodeId: string, requestId: string): string {
  return `approval:${executorNodeId}:${requestId}`
}

export function hookItemKey(executorNodeId: string, key: string): string {
  return `hook:${executorNodeId}:${key}`
}

export function attentionItemCount(links: readonly OrchestrationAttentionLinkDto[]): number {
  return links.reduce((total, link) => total + link.approvals.length + link.hooks.length, 0)
}

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * The window reads `orch.approval.list` after every attention event and keeps what the Worker
 * said. Nothing is removed locally: an item disappears when a read after the action no longer
 * returns it. The store never writes links, approvals or hooks.
 */
export function createOrchestrationAttentionStore(
  client: OrchestrationAttentionClient,
): OrchestrationAttentionStore {
  const store = createStore<OrchestrationAttentionState>(() => ({
    linksRevision: 0,
    links: EMPTY_LINKS,
    loaded: false,
    errorCode: null,
    closedCode: null,
    actionErrorCode: null,
    notice: null,
    inFlight: [],
  }))

  let inFlightRead: Promise<void> | null = null
  let rerun = false
  let readSeq = 0
  let appliedSeq = 0

  async function readOnce(): Promise<void> {
    const seq = ++readSeq
    let raw: unknown
    try {
      raw = await client.list()
    } catch (error) {
      if (seq < appliedSeq) {
        return
      }
      appliedSeq = seq
      store.setState({ errorCode: codeOf(error) ?? 'common.unexpected' })
      return
    }
    const parsed = orchestrationAttentionResultSchema.safeParse(raw)
    if (!parsed.success) {
      if (seq < appliedSeq) {
        return
      }
      appliedSeq = seq
      store.setState({ errorCode: 'common.unexpected' })
      return
    }
    if (seq < appliedSeq) {
      return
    }
    appliedSeq = seq
    store.setState({
      linksRevision: parsed.data.linksRevision,
      links: parsed.data.links,
      loaded: true,
      errorCode: null,
      closedCode: null,
    })
  }

  async function drain(): Promise<void> {
    await readOnce()
    if (rerun) {
      rerun = false
      await readOnce()
      // An event during the repeated read does not open a third one; the next event will.
      rerun = false
    }
  }

  function refresh(): Promise<void> {
    if (inFlightRead) {
      rerun = true
      return inFlightRead
    }
    inFlightRead = drain().finally(() => {
      inFlightRead = null
    })
    return inFlightRead
  }

  function handleSyncEvent(event: SyncEventPayload): void {
    if (event.type === 'orchestration.links.updated' || event.type === 'resync_required') {
      void refresh()
    }
  }

  function setInFlight(key: string, active: boolean): void {
    store.setState(previous => ({
      inFlight: active
        ? previous.inFlight.includes(key)
          ? previous.inFlight
          : [...previous.inFlight, key]
        : previous.inFlight.filter(item => item !== key),
    }))
  }

  function endSurface(code: string): boolean {
    if (code === 'orch.forbidden' || code === 'orch.not_linked') {
      store.setState({ closedCode: code })
      return true
    }
    return false
  }

  async function runItem(key: string, task: () => Promise<void>): Promise<void> {
    if (store.getState().inFlight.includes(key)) {
      return
    }
    setInFlight(key, true)
    store.setState({ actionErrorCode: null, notice: null })
    try {
      await task()
    } finally {
      setInFlight(key, false)
    }
  }

  async function respondApproval(
    input: Parameters<OrchestrationAttentionStore['respondApproval']>[0],
  ): Promise<void> {
    await runItem(approvalItemKey(input.executorNodeId, input.requestId), async () => {
      try {
        await client.respondApproval(input)
        await refresh()
      } catch (error) {
        const code = codeOf(error)
        if (code === 'orch.approval_not_found') {
          store.setState({ notice: { kind: 'approval_already_answered' } })
          await refresh()
          return
        }
        if (code === 'orch.executor_unavailable') {
          store.setState({ actionErrorCode: code })
          return
        }
        if (code !== null && endSurface(code)) {
          return
        }
        store.setState({ actionErrorCode: code ?? 'common.unexpected' })
      }
    })
  }

  async function approveHook(
    input: Parameters<OrchestrationAttentionStore['approveHook']>[0],
  ): Promise<void> {
    await runItem(hookItemKey(input.executorNodeId, input.key), async () => {
      try {
        const result = await client.approveHooks({
          executorNodeId: input.executorNodeId,
          keys: [input.key],
        })
        await refresh()
        if (result.restart === 'scheduled') {
          store.setState({ notice: { kind: 'hook_restart_scheduled' } })
        }
      } catch (error) {
        const code = codeOf(error)
        if (code === 'common.invalid_input') {
          store.setState({ notice: { kind: 'hook_changed' } })
          await refresh()
          return
        }
        if (code === 'orch.executor_unavailable') {
          store.setState({ actionErrorCode: code })
          return
        }
        if (code !== null && endSurface(code)) {
          return
        }
        store.setState({ actionErrorCode: code ?? 'common.unexpected' })
      }
    })
  }

  return {
    store,
    refresh,
    handleSyncEvent,
    respondApproval,
    approveHook,
    dismissNotice: () => store.setState({ notice: null }),
    reset: () => {
      readSeq = 0
      appliedSeq = 0
      rerun = false
      store.setState({
        linksRevision: 0,
        links: EMPTY_LINKS,
        loaded: false,
        errorCode: null,
        closedCode: null,
        actionErrorCode: null,
        notice: null,
        inFlight: [],
      })
    },
  }
}

function invokeControlSurface<T>(request: Parameters<OpenCoveApiControlSurface['invoke']>[0]) {
  const api = window.opencoveApi?.controlSurface
  if (!api) {
    throw createAppError('common.unavailable')
  }
  return api.invoke<T>(request)
}

type OpenCoveApiControlSurface = NonNullable<Window['opencoveApi']>['controlSurface']

function createWindowAttentionClient(): OrchestrationAttentionClient {
  return {
    list: async () =>
      await invokeControlSurface<OrchestrationAttentionResult>({
        kind: 'query',
        id: 'orch.approval.list',
        payload: {},
      }),
    respondApproval: async input =>
      await invokeControlSurface({
        kind: 'command',
        id: 'orch.approval.respond',
        payload: input,
      }),
    approveHooks: async input =>
      await invokeControlSurface<OrchestrationHooksApproveResult>({
        kind: 'command',
        id: 'orch.hooks.approve',
        payload: input,
      }),
  }
}

export const orchestrationAttention = createOrchestrationAttentionStore(
  createWindowAttentionClient(),
)
