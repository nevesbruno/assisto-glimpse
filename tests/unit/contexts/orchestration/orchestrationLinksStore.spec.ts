import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationLinksStore } from '../../../../src/contexts/orchestration/presentation/renderer/orchestrationLinksStore'

const link = (id: string) => ({
  id,
  projectId: 'p1',
  spaceId: 's1',
  orchestratorNodeId: 'orch',
  executorNodeId: 'exec',
  kind: 'executor',
  origin: 'orchestrator_spawn',
  runtimeMode: 'service',
  provider: 'codex',
  state: 'active',
  closeReason: null,
  health: 'ready',
  roundsUsed: 0,
  roundsLimit: 10,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  revision: 1,
})

function fakeClient(initial: unknown) {
  const state = { mirror: initial, reads: 0, fail: false }
  return {
    state,
    client: {
      readMirror: async () => {
        state.reads += 1
        if (state.fail) {
          throw new Error('offline')
        }
        return state.mirror
      },
    },
  }
}

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

describe('orchestrationLinksStore', () => {
  it('loads the mirror from the synced state', async () => {
    const fake = fakeClient({ linksRevision: 1, links: [link(ID_A)] })
    const { store, refresh } = createOrchestrationLinksStore(fake.client)
    await refresh()
    expect(store.getState().links.map(item => item.id)).toEqual([ID_A])
    expect(store.getState().linksRevision).toBe(1)
  })

  it('reapplies the mirror on orchestration.links.updated', async () => {
    const fake = fakeClient({ linksRevision: 1, links: [link(ID_A)] })
    const handle = createOrchestrationLinksStore(fake.client)
    await handle.refresh()
    fake.state.mirror = { linksRevision: 2, links: [link(ID_A), link(ID_B)] }
    handle.handleSyncEvent({
      type: 'orchestration.links.updated',
      revision: 5,
      linksRevision: 2,
      operationId: 'orch.link.create',
    })
    await handle.refresh()
    expect(handle.store.getState().links).toHaveLength(2)
  })

  it('reapplies on resync_required even if the revision went backwards', async () => {
    const fake = fakeClient({ linksRevision: 7, links: [link(ID_A)] })
    const handle = createOrchestrationLinksStore(fake.client)
    await handle.refresh()
    fake.state.mirror = { linksRevision: 3, links: [] }
    await handle.refresh()
    expect(handle.store.getState().links).toHaveLength(1)
    handle.handleSyncEvent({ type: 'resync_required', revision: 9 })
    await handle.refresh({ force: true })
    expect(handle.store.getState()).toMatchObject({ linksRevision: 3, links: [] })
  })

  it('keeps the last good state on read failure or invalid mirror', async () => {
    const fake = fakeClient({ linksRevision: 1, links: [link(ID_A)] })
    const { store, refresh } = createOrchestrationLinksStore(fake.client)
    await refresh()
    fake.state.fail = true
    await refresh()
    fake.state.fail = false
    fake.state.mirror = { linksRevision: 'x' }
    await refresh()
    expect(store.getState().links).toHaveLength(1)
  })

  it('coalesces concurrent refreshes into one trailing read', async () => {
    const fake = fakeClient({ linksRevision: 1, links: [] })
    const { refresh } = createOrchestrationLinksStore(fake.client)
    await Promise.all([refresh(), refresh(), refresh()])
    expect(fake.state.reads).toBe(2)
  })

  it('ignores unrelated events', async () => {
    const fake = fakeClient(null)
    const handle = createOrchestrationLinksStore(fake.client)
    handle.handleSyncEvent({ type: 'canvas.focus' } as never)
    await handle.refresh()
    expect(fake.state.reads).toBe(1)
    expect(handle.store.getState().links).toEqual([])
  })

  describe('trace on a mirror that fails to parse', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('logs the reason without throwing and keeps the state', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const fake = fakeClient({ linksRevision: 1, links: [{ ...link(ID_A), kind: 'bogus' }] })
      const { store, refresh } = createOrchestrationLinksStore(fake.client)
      await expect(refresh()).resolves.toBeUndefined()
      expect(store.getState().links).toHaveLength(0)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.join(' '))).toMatch(/links mirror rejected.*links\.0\.kind/)
    })

    it('accepts a link outside any space (empty spaceId)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const fake = fakeClient({ linksRevision: 1, links: [{ ...link(ID_A), spaceId: '' }] })
      const { store, refresh } = createOrchestrationLinksStore(fake.client)
      await refresh()
      expect(store.getState().links).toHaveLength(1)
      expect(warn).not.toHaveBeenCalled()
    })

    it('does not repeat the same failure on every read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const fake = fakeClient({ linksRevision: 'x' })
      const { refresh } = createOrchestrationLinksStore(fake.client)
      await refresh()
      await refresh()
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('stays silent when the state has no mirror yet', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { refresh } = createOrchestrationLinksStore(fakeClient(null).client)
      await refresh()
      expect(warn).not.toHaveBeenCalled()
    })
  })
})
