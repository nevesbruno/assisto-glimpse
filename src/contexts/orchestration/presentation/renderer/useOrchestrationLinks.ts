import { useEffect } from 'react'
import { useStore } from 'zustand'
import type { OrchestrationLinkDto } from '@shared/contracts/dto/orchestration'
import { orchestrationLinks } from './orchestrationLinksStore'

/** Links from the synced mirror, for display only. Updates arrive through useWorkerSyncStateUpdates. */
export function useOrchestrationLinks(): OrchestrationLinkDto[] {
  useEffect(() => {
    void orchestrationLinks.refresh()
  }, [])

  return useStore(orchestrationLinks.store, state => state.links)
}
