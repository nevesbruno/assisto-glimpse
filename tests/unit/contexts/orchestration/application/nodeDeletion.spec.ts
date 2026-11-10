import { describe, expect, it } from 'vitest'
import {
  createDispatch,
  type DispatchState,
} from '../../../../../src/contexts/orchestration/domain/dispatch'
import { orchestratorPrincipal, sha256, spawnedHarness, uuidFrom, type Harness } from './fakes'

const D = uuidFrom('node-deletion-1')
const SECOND_SPAWN_ID = '33333333-3333-4333-8333-333333333333'

function seed(harness: Harness, linkId: string, state: DispatchState) {
  const link = harness.links.rows.get(linkId)!
  const { dispatch } = createDispatch({
    id: D,
    link,
    text: 'work',
    textSha256: sha256('work'),
    now: harness.clock.now(),
  })
  const at = harness.clock.now().toISOString()
  harness.links.rows.set(linkId, { ...link, roundsUsed: dispatch.round })
  harness.dispatches.rows.set(D, {
    ...dispatch,
    state,
    text: state === 'queued' ? 'work' : null,
    reservedAt: state === 'queued' ? null : at,
    sentAt: state === 'sent' ? at : null,
    turnRef: state === 'sent' ? 'turn-9' : null,
    revision: 3,
  })
}

describe('node deletion reconciler', () => {
  it('an executor that left the state closes the link with node_deleted and ends the service', async () => {
    const { harness, executorNodeId, linkId, runtime } = await spawnedHarness()
    const before = harness.published.length
    harness.nodes.delete(executorNodeId)

    await harness.service.reconcileDeletedNodes()

    const link = harness.links.rows.get(linkId)!
    expect(link.state).toBe('closed')
    expect(link.closeReason).toBe('node_deleted')
    expect(runtime.closes).toEqual(['node_deleted'])
    expect(harness.published.length).toBeGreaterThan(before)
  })

  it('cancels the queued dispatch and gives the round back', async () => {
    const { harness, executorNodeId, linkId } = await spawnedHarness()
    seed(harness, linkId, 'queued')
    harness.nodes.delete(executorNodeId)

    await harness.service.reconcileDeletedNodes()

    expect(harness.dispatches.rows.get(D)!.state).toBe('cancelled')
    expect(harness.links.rows.get(linkId)!.roundsUsed).toBe(0)
  })

  it('interrupts the open turn before closing the service', async () => {
    const { harness, executorNodeId, linkId, runtime } = await spawnedHarness()
    seed(harness, linkId, 'sent')
    harness.nodes.delete(executorNodeId)

    await harness.service.reconcileDeletedNodes()

    expect(runtime.interrupts).toEqual(['turn-9'])
    expect(runtime.closes).toEqual(['node_deleted'])
    expect(harness.links.rows.get(linkId)!.state).toBe('closed')
  })

  it('an orchestrator that left the state closes every link of it', async () => {
    const { harness, linkId } = await spawnedHarness()
    const second = await harness.service.spawn(orchestratorPrincipal(), {
      requestId: SECOND_SPAWN_ID,
      provider: 'codex',
    })
    await harness.service.whenIdle()
    harness.nodes.delete('orq')

    await harness.service.reconcileDeletedNodes()

    expect(harness.links.rows.get(linkId)!.closeReason).toBe('node_deleted')
    expect(harness.links.rows.get(second.linkId)!.closeReason).toBe('node_deleted')
  })

  it('writes and publishes nothing when every node is still there', async () => {
    const { harness } = await spawnedHarness()
    const revision = harness.links.revision
    const published = harness.published.length

    await harness.service.reconcileDeletedNodes()

    expect(harness.links.revision).toBe(revision)
    expect(harness.published).toHaveLength(published)
  })

  it.each([
    ['the state read fails', { fail: true }],
    ['the state has no workspace', { noWorkspace: true }],
  ])('closes nothing when %s', async (_name, change) => {
    const { harness, executorNodeId, linkId } = await spawnedHarness()
    harness.nodes.delete(executorNodeId)
    Object.assign(harness.appState, change)

    await harness.service.reconcileDeletedNodes()

    expect(harness.links.rows.get(linkId)!.state).toBe('active')
  })

  it('at boot closes the link of a node that is gone without starting its service', async () => {
    const { harness, executorNodeId, linkId } = await spawnedHarness()
    harness.nodes.delete(executorNodeId)
    const starts = harness.starts.length
    const service = harness.restart()

    await service.reconcileOnBoot()
    await service.whenIdle()

    expect(harness.links.rows.get(linkId)!.closeReason).toBe('node_deleted')
    expect(harness.starts).toHaveLength(starts)
  })

  it('at boot a stopped Worker does not start a service for a link', async () => {
    const { harness } = await spawnedHarness()
    const starts = harness.starts.length
    harness.appState.stopped = true
    const service = harness.restart()

    await service.reconcileOnBoot()
    await service.whenIdle()

    expect(harness.starts).toHaveLength(starts)
  })
})
