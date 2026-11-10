// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentLink } from '../../../src/contexts/orchestration/domain/agentLink'
import { createOrchestrationLinksMirror } from '../../../src/app/main/controlSurface/orchestration/orchestrationLinksMirror'
import { orchestrationLinksMirrorSchema } from '../../../src/shared/contracts/dto/orchestration'
import type { SyncEventPayload } from '../../../src/shared/contracts/dto/sync'
import { buildLink } from './persistence/orchestrationDb'

const LINK_ID = '2f1c3b0e-6d5a-4b8e-9a77-1d3f5c7a9b11'

function setup(initial: readonly AgentLink[], linksRevision = 3) {
  const state = { links: initial, linksRevision, appRevision: 40, health: 'ready' as const }
  const written: unknown[] = []
  const events: SyncEventPayload[] = []
  const log: string[] = []
  const mirror = createOrchestrationLinksMirror({
    links: {
      listActive: async () => state.links,
      readLinksRevision: async () => state.linksRevision,
    },
    writeMirror: value => {
      written.push(value)
      log.push(`write:${value.linksRevision}`)
    },
    publish: event => {
      events.push(event)
      log.push(
        `publish:${event.type === 'orchestration.links.updated' ? event.linksRevision : '?'}`,
      )
    },
    ids: { uuid: () => 'op-1', uuidV5: () => 'unused' },
    readAppStateRevision: async () => state.appRevision,
    healthOf: () => state.health,
  })
  return { state, written, events, log, mirror }
}

describe('orchestration links mirror', () => {
  it('writes a schema-valid mirror with the health of each link', async () => {
    const { written, mirror } = setup([buildLink(LINK_ID)])

    await mirror.sync()

    const parsed = orchestrationLinksMirrorSchema.parse(written[0])
    expect(parsed.linksRevision).toBe(3)
    expect(parsed.links).toHaveLength(1)
    expect(parsed.links[0]).toMatchObject({
      id: LINK_ID,
      health: 'ready',
      executorNodeId: 'exec-' + LINK_ID,
    })
    expect(parsed.links[0]).not.toHaveProperty('spawnRequestId')
    expect(parsed.links[0]).not.toHaveProperty('serviceTokenSha256')
  })

  it('publishes one event per change, with operationId and the app revision', async () => {
    const { events, mirror } = setup([buildLink(LINK_ID)])

    mirror.publishLinksUpdated({ linksRevision: 3, projectIds: ['project-1'] })
    await mirror.idle()

    expect(events).toEqual([
      { type: 'orchestration.links.updated', revision: 40, linksRevision: 3, operationId: 'op-1' },
    ])
  })

  it('writes the mirror before each publish, once per change', async () => {
    const { state, log, mirror } = setup([buildLink(LINK_ID)])

    mirror.publishLinksUpdated({ linksRevision: 3, projectIds: [] })
    await mirror.idle()
    state.linksRevision = 4
    mirror.publishLinksUpdated({ linksRevision: 4, projectIds: [] })
    await mirror.idle()

    expect(log).toEqual(['write:3', 'publish:3', 'write:4', 'publish:4'])
  })

  it('reconciliation rewrites the mirror without publishing', async () => {
    const { written, events, mirror } = setup([buildLink(LINK_ID)])

    await mirror.sync({ publish: false })

    expect(written).toHaveLength(1)
    expect(events).toHaveLength(0)
  })

  it('a forged mirror in the store is replaced by the next reconciliation', async () => {
    const { state, written, mirror } = setup([buildLink(LINK_ID)])
    await mirror.sync({ publish: false })
    const forged = { linksRevision: 99, links: [{ id: 'forged' }] }
    state.linksRevision = 5

    await mirror.sync({ publish: false })

    expect(written.at(-1)).not.toEqual(forged)
    expect(orchestrationLinksMirrorSchema.parse(written.at(-1)).linksRevision).toBe(5)
  })

  it('a failed write does not publish and does not break later changes', async () => {
    const { state, events, mirror } = setup([buildLink(LINK_ID)])
    const failing = createOrchestrationLinksMirror({
      links: { listActive: async () => state.links, readLinksRevision: async () => 1 },
      writeMirror: () => {
        throw new Error('disk full')
      },
      publish: event => events.push(event),
      ids: { uuid: () => 'op-2', uuidV5: () => 'unused' },
      readAppStateRevision: async () => 1,
      healthOf: () => 'ready',
    })

    failing.publishLinksUpdated({ linksRevision: 1, projectIds: [] })
    await failing.idle()
    await mirror.sync()

    expect(events).toHaveLength(1)
  })
})
