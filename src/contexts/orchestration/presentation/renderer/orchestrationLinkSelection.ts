import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { invokeOrchestrationControlSurface } from './orchestrationControlSurfaceApi'
import { orchestrationLinks } from './orchestrationLinksStore'

export interface OrchestrationLinkCloseClient {
  closeLink: (input: { readonly linkId: string; readonly force: boolean }) => Promise<unknown>
  /** Re-reads the display mirror after a successful close. */
  refreshMirror: () => Promise<void>
}

export type OrchestrationLinkClosePhase = 'confirm' | 'force'

export interface OrchestrationLinkBlockingDispatch {
  readonly state: 'queued' | 'reserved' | 'sent' | 'uncertain'
  readonly round: number
}

export interface OrchestrationLinkSelectionState {
  /** Link of the selected arrow; the arrow is redrawn from this value, never from React Flow. */
  selectedLinkId: string | null
  /** Link whose close confirmation is open. */
  closingLinkId: string | null
  phase: OrchestrationLinkClosePhase
  inFlight: boolean
  /** Code of the last failed close, shown beside the confirmation. */
  errorCode: string | null
  /** Open dispatch that refused the close without `force`. */
  blocking: OrchestrationLinkBlockingDispatch | null
}

export interface OrchestrationLinkSelectionStore {
  store: StoreApi<OrchestrationLinkSelectionState>
  select: (linkId: string | null) => void
  requestClose: (linkId: string) => void
  cancelClose: () => void
  confirmClose: () => Promise<void>
  forceClose: () => Promise<void>
}

const IDLE: OrchestrationLinkSelectionState = {
  selectedLinkId: null,
  closingLinkId: null,
  phase: 'confirm',
  inFlight: false,
  errorCode: null,
  blocking: null,
}

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

const BLOCKING_STATES: readonly string[] = ['queued', 'reserved', 'sent', 'uncertain']

function blockingOf(error: unknown): OrchestrationLinkBlockingDispatch | null {
  const details = (error as { details?: unknown } | null)?.details
  if (!details || typeof details !== 'object') {
    return null
  }
  const { state, round } = details as { state?: unknown; round?: unknown }
  if (
    typeof state !== 'string' ||
    !BLOCKING_STATES.includes(state) ||
    typeof round !== 'number' ||
    !Number.isInteger(round)
  ) {
    return null
  }
  return { state: state as OrchestrationLinkBlockingDispatch['state'], round }
}

function createWindowCloseClient(): OrchestrationLinkCloseClient {
  return {
    closeLink: ({ linkId, force }) =>
      invokeOrchestrationControlSurface({
        kind: 'command',
        id: 'orch.link.close',
        payload: { linkId, force },
      }),
    refreshMirror: () => orchestrationLinks.refresh({ force: true }),
  }
}

/**
 * Display state of the orchestration arrows. The close call is the user's: the popover always
 * asks once, and only the second click on `Interromper e desligar` carries `force`.
 */
export function createOrchestrationLinkSelectionStore(
  client: OrchestrationLinkCloseClient,
): OrchestrationLinkSelectionStore {
  const store = createStore<OrchestrationLinkSelectionState>(() => IDLE)

  function select(linkId: string | null): void {
    const current = store.getState()
    if (current.selectedLinkId === linkId && current.closingLinkId === null) {
      return
    }
    store.setState({
      ...IDLE,
      selectedLinkId: linkId,
    })
  }

  function requestClose(linkId: string): void {
    store.setState({
      ...IDLE,
      selectedLinkId: linkId,
      closingLinkId: linkId,
    })
  }

  function cancelClose(): void {
    const current = store.getState()
    if (current.inFlight) {
      return
    }
    store.setState({
      ...current,
      closingLinkId: null,
      phase: 'confirm',
      errorCode: null,
      blocking: null,
    })
  }

  async function runClose(force: boolean): Promise<void> {
    const current = store.getState()
    const linkId = current.closingLinkId
    if (!linkId || current.inFlight) {
      return
    }
    store.setState({ ...current, inFlight: true, errorCode: null })
    try {
      await client.closeLink({ linkId, force })
    } catch (error) {
      const code = codeOf(error)
      const blocking = code === 'orch.dispatch_in_flight' ? blockingOf(error) : null
      if (blocking) {
        store.setState({
          ...store.getState(),
          inFlight: false,
          phase: 'force',
          errorCode: null,
          blocking,
        })
        return
      }
      store.setState({
        ...store.getState(),
        inFlight: false,
        errorCode: code ?? 'common.unexpected',
      })
      return
    }
    store.setState({ ...IDLE })
    await client.refreshMirror()
  }

  return {
    store,
    select,
    requestClose,
    cancelClose,
    confirmClose: () => runClose(false),
    forceClose: () => runClose(true),
  }
}

export const orchestrationLinkSelection =
  createOrchestrationLinkSelectionStore(createWindowCloseClient())

export function useOrchestrationLinkSelectionState<T>(
  selector: (state: OrchestrationLinkSelectionState) => T,
): T {
  return useStore(orchestrationLinkSelection.store, selector)
}
