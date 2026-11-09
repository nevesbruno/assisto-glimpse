import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  orchestrationLinksMirrorSchema,
  type OrchestrationLinkDto,
} from '@shared/contracts/dto/orchestration'
import type { SyncEventPayload } from '@shared/contracts/dto'
import { getPersistencePort } from '@contexts/workspace/presentation/renderer/utils/persistence/port'

export interface OrchestrationLinksClient {
  /** Reads the display mirror from the synced app state; null when the state has none. */
  readMirror: () => Promise<unknown | null>
}

export interface OrchestrationLinksState {
  linksRevision: number
  links: OrchestrationLinkDto[]
}

export interface OrchestrationLinksStore {
  store: StoreApi<OrchestrationLinksState>
  refresh: (options?: { force?: boolean }) => Promise<void>
  handleSyncEvent: (event: SyncEventPayload) => void
}

const EMPTY_LINKS: OrchestrationLinkDto[] = []

/**
 * Display-only copy of the Worker's link mirror. Nothing here is consulted for authorization.
 * Reads are serialized and coalesced, so a burst of events costs one trailing read.
 */
export function createOrchestrationLinksStore(
  client: OrchestrationLinksClient,
): OrchestrationLinksStore {
  const store = createStore<OrchestrationLinksState>(() => ({
    linksRevision: 0,
    links: EMPTY_LINKS,
  }))
  let inFlight: Promise<void> | null = null
  let rerun: { force: boolean } | null = null

  async function readOnce(force: boolean): Promise<void> {
    let raw: unknown
    try {
      raw = await client.readMirror()
    } catch {
      return
    }
    const parsed = orchestrationLinksMirrorSchema.safeParse(raw)
    if (!parsed.success) {
      return
    }
    const current = store.getState()
    if (!force && parsed.data.linksRevision < current.linksRevision) {
      return
    }
    store.setState({ linksRevision: parsed.data.linksRevision, links: parsed.data.links })
  }

  async function drain(force: boolean): Promise<void> {
    await readOnce(force)
    const next = rerun
    if (next) {
      rerun = null
      await drain(next.force)
    }
  }

  function refresh(options?: { force?: boolean }): Promise<void> {
    const force = options?.force === true
    if (inFlight) {
      rerun = { force: force || rerun?.force === true }
      return inFlight
    }
    inFlight = drain(force).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function handleSyncEvent(event: SyncEventPayload): void {
    if (event.type === 'orchestration.links.updated') {
      void refresh()
    } else if (event.type === 'resync_required') {
      void refresh({ force: true })
    }
  }

  return { store, refresh, handleSyncEvent }
}

function createWindowLinksClient(): OrchestrationLinksClient {
  return {
    readMirror: async () => {
      const result = await getPersistencePort()?.readAppState()
      const state = result?.state
      if (!state || typeof state !== 'object') {
        return null
      }
      return (state as { orchestrationLinks?: unknown }).orchestrationLinks ?? null
    },
  }
}

export const orchestrationLinks = createOrchestrationLinksStore(createWindowLinksClient())
