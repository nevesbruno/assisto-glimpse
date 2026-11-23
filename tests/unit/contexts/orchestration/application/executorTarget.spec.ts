import { describe, expect, it } from 'vitest'
import { resolveExecutorTarget } from '../../../../../src/contexts/orchestration/application/executorTarget'
import type { AgentLink } from '../../../../../src/contexts/orchestration/domain/agentLink'
import type { OrchestrationPrincipal } from '../../../../../src/contexts/orchestration/domain/orchestrationAuthorization'
import { bootedHarness, orchestratorPrincipal, USER, uuidFrom } from './fakes'

const orq = orchestratorPrincipal()
const otherOrq = orchestratorPrincipal('orq-2')
const executorOf = (nodeId: string): OrchestrationPrincipal => ({
  kind: 'agent',
  nodeId,
  projectId: 'p1',
  spaceId: 's1',
  sessionId: `session-${nodeId}`,
  provider: 'codex',
  grantActive: true,
})

function linkOf(executorNodeId: string, overrides: Partial<AgentLink> = {}): AgentLink {
  return {
    id: `link-${executorNodeId}`,
    projectId: 'p1',
    spaceId: 's1',
    orchestratorNodeId: 'orq',
    executorNodeId,
    kind: 'executor',
    origin: 'orchestrator_spawn',
    runtimeMode: 'service',
    provider: 'codex',
    state: 'active',
    closeReason: null,
    requestReason: null,
    requestedAt: null,
    messagesLimit: 5,
    messagesUsedSource: 0,
    messagesUsedTarget: 0,
    spawnRequestId: null,
    executorSessionRef: null,
    servicePid: null,
    serviceTokenSha256: null,
    roundsUsed: 0,
    roundsLimit: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    revision: 1,
    ...overrides,
  }
}

function depsOf(links: AgentLink[], titles: Record<string, string>) {
  return {
    links: { listActive: async () => links },
    nodes: {
      findNode: async (nodeId: string) => {
        const title = titles[nodeId]
        return title === undefined
          ? null
          : { nodeId, projectId: 'p1', spaceId: 's1', provider: 'codex', title, cwd: '/w' }
      },
    },
  }
}

const codeOf = (run: () => Promise<unknown>) =>
  run().then(
    () => 'allowed',
    (error: { code?: string }) => error.code,
  )

describe('executor target resolution', () => {
  const alpha = linkOf('exec-1')

  it('resolves an executor by node id', async () => {
    await expect(
      resolveExecutorTarget(depsOf([alpha], { 'exec-1': 'alpha' }), orq, 'exec-1'),
    ).resolves.toBe(alpha)
  })

  it('resolves an executor by the node title', async () => {
    await expect(
      resolveExecutorTarget(depsOf([alpha], { 'exec-1': 'alpha' }), orq, 'alpha'),
    ).resolves.toBe(alpha)
  })

  it('refuses an ambiguous title with a clear error', async () => {
    const beta = linkOf('exec-2')
    const deps = depsOf([alpha, beta], { 'exec-1': 'dup', 'exec-2': 'dup' })
    await expect(resolveExecutorTarget(deps, orq, 'dup')).rejects.toMatchObject({
      code: 'orch.link_invalid',
      message: 'more than one linked executor is titled "dup"; use the node id',
    })
  })

  it('cannot see a title or id from a foreign project or orchestrator', async () => {
    const foreign = linkOf('exec-foreign', { projectId: 'p2', orchestratorNodeId: 'orq-2' })
    const own = linkOf('exec-own')
    const deps = depsOf([own, foreign], { 'exec-own': 'alpha', 'exec-foreign': 'foreign' })
    await expect(resolveExecutorTarget(deps, orq, 'foreign')).resolves.toBeNull()
    await expect(resolveExecutorTarget(deps, orq, 'exec-foreign')).resolves.toBeNull()
    await expect(resolveExecutorTarget(deps, otherOrq, 'foreign')).resolves.toBeNull()
    await expect(resolveExecutorTarget(deps, USER, 'foreign')).resolves.toBe(foreign)
  })

  it('never resolves for a linked executor principal', async () => {
    await expect(
      resolveExecutorTarget(depsOf([alpha], { 'exec-1': 'alpha' }), executorOf('exec-1'), 'alpha'),
    ).resolves.toBeNull()
  })
})

describe('orch close by target', () => {
  async function spawnTitled(...titles: string[]) {
    const harness = await bootedHarness()
    const spawned = await Promise.all(
      titles.map((title, index) =>
        harness.service.spawn(orq, {
          requestId: uuidFrom(`spawn-${index}-${title}`),
          provider: 'codex',
          title,
        }),
      ),
    )
    await harness.service.whenIdle()
    return { harness, ids: spawned.map(result => result.executorNodeId) }
  }

  it('closes a linked executor by title', async () => {
    const { harness, ids } = await spawnTitled('alpha', 'beta')
    await harness.service.close(orq, { to: 'alpha' })
    const rows = [...harness.links.rows.values()]
    expect(rows.find(link => link.executorNodeId === ids[0])).toMatchObject({
      state: 'closed',
      closeReason: 'orchestrator',
    })
    expect(rows.find(link => link.executorNodeId === ids[1])?.state).toBe('active')
  })

  it('keeps closing by node id', async () => {
    const { harness, ids } = await spawnTitled('alpha')
    await harness.service.close(orq, { to: ids[0] })
    expect([...harness.links.rows.values()][0]).toMatchObject({ state: 'closed' })
  })

  it('refuses an ambiguous title', async () => {
    const { harness } = await spawnTitled('dup', 'dup')
    await expect(harness.service.close(orq, { to: 'dup' })).rejects.toMatchObject({
      code: 'orch.link_invalid',
      message: 'more than one linked executor is titled "dup"; use the node id',
    })
  })

  it('does not close a relinked executor when the link changes before the slot', async () => {
    const { harness, ids } = await spawnTitled('alpha')
    const stale = [...harness.links.rows.values()].find(link => link.executorNodeId === ids[0])!
    const relinked = { ...stale, id: 'link-relinked' }
    let swapped = false
    harness.links.findActiveByExecutor = async (nodeId: string) => {
      if (!swapped && nodeId === ids[0]) {
        swapped = true
        harness.links.rows.delete(stale.id)
        harness.links.rows.set(relinked.id, relinked)
      }
      return (
        [...harness.links.rows.values()].find(
          row => row.state === 'active' && row.executorNodeId === nodeId,
        ) ?? null
      )
    }
    await expect(harness.service.close(orq, { to: 'alpha' })).rejects.toMatchObject({
      code: 'orch.not_linked',
    })
    expect(swapped).toBe(true)
    expect(harness.links.rows.get(relinked.id)?.state).toBe('active')
  })

  it('answers a foreign title like a missing one and keeps the forbidden matrix', async () => {
    const { harness, ids } = await spawnTitled('alpha')
    harness.nodes.set('exec-foreign', {
      nodeId: 'exec-foreign',
      provider: 'codex',
      title: 'foreign',
      projectId: 'p2',
    })
    harness.links.rows.set(
      'link-exec-foreign',
      linkOf('exec-foreign', { projectId: 'p2', orchestratorNodeId: 'orq-2' }),
    )
    expect(await codeOf(() => harness.service.close(orq, { to: 'foreign' }))).toBe(
      'orch.not_linked',
    )
    expect(await codeOf(() => harness.service.close(orq, { to: 'missing' }))).toBe(
      'orch.not_linked',
    )
    expect(await codeOf(() => harness.service.close(executorOf(ids[0]), { to: 'alpha' }))).toBe(
      'orch.forbidden',
    )
  })
})
