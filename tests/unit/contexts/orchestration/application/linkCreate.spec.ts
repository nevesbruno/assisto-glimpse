import { describe, expect, it } from 'vitest'
import { bootedHarness, codedError, ORCHESTRATOR, orchestratorPrincipal, USER } from './fakes'

const EXECUTOR = 'exec-manual'

async function harnessWithNodes() {
  const harness = await bootedHarness()
  harness.nodes.set(EXECUTOR, { nodeId: EXECUTOR, provider: 'codex', title: 'manual' })
  const input = { orchestratorNodeId: ORCHESTRATOR, executorNodeId: EXECUTOR }
  return { harness, input }
}

describe('createLink (orch.link.create)', () => {
  it('links two canvas nodes, starts the service, relaunches the TUI and answers linkId and runtimeMode', async () => {
    const { harness, input } = await harnessWithNodes()
    const result = await harness.service.createLink(USER, input)
    await harness.service.whenIdle()
    expect(result).toEqual({ linkId: expect.any(String), runtimeMode: 'service' })
    expect([...harness.links.rows.values()][0]).toMatchObject({
      id: result.linkId,
      origin: 'canvas_manual',
      spawnRequestId: null,
      state: 'active',
      executorNodeId: EXECUTOR,
      orchestratorNodeId: ORCHESTRATOR,
    })
    expect(harness.starts).toHaveLength(1)
    expect(harness.tuiRelaunches).toEqual([EXECUTOR])
    expect(harness.service.healthOf(EXECUTOR)).toBe('ready')
  })

  it('refuses an agent principal', async () => {
    const { harness, input } = await harnessWithNodes()
    await expect(harness.service.createLink(orchestratorPrincipal(), input)).rejects.toMatchObject({
      code: 'orch.forbidden',
    })
    expect(harness.links.rows.size).toBe(0)
  })

  it.each(['orchestratorNodeId', 'executorNodeId'] as const)(
    'a missing %s is link_invalid',
    async key => {
      const { harness, input } = await harnessWithNodes()
      await expect(
        harness.service.createLink(USER, { ...input, [key]: 'ghost' }),
      ).rejects.toMatchObject({ code: 'orch.link_invalid' })
      expect(harness.links.rows.size).toBe(0)
      expect(harness.starts).toHaveLength(0)
    },
  )

  it('the same node on both sides is link_invalid', async () => {
    const { harness } = await harnessWithNodes()
    await expect(
      harness.service.createLink(USER, {
        orchestratorNodeId: ORCHESTRATOR,
        executorNodeId: ORCHESTRATOR,
      }),
    ).rejects.toMatchObject({ code: 'orch.link_invalid' })
  })

  it('a node of another project is indistinguishable from a missing node', async () => {
    const { harness, input } = await harnessWithNodes()
    const missing = await harness.service
      .createLink(USER, { ...input, executorNodeId: 'ghost' })
      .catch((error: unknown) => error)
    harness.nodes.set(EXECUTOR, {
      nodeId: EXECUTOR,
      provider: 'codex',
      title: 'x',
      projectId: 'p2',
    })
    const crossProject = await harness.service
      .createLink(USER, input)
      .catch((error: unknown) => error)
    expect(missing).toMatchObject({ code: 'orch.link_invalid' })
    expect(crossProject).toEqual(missing)
    expect(harness.links.rows.size).toBe(0)
  })

  it('an executor already linked is link_invalid and keeps the first link', async () => {
    const { harness, input } = await harnessWithNodes()
    await harness.service.createLink(USER, input)
    await expect(harness.service.createLink(USER, input)).rejects.toMatchObject({
      code: 'orch.link_invalid',
    })
    expect([...harness.links.rows.values()].filter(link => link.state === 'active')).toHaveLength(1)
  })

  it('a service failure closes the link as spawn_failed and reports the executor as unavailable', async () => {
    const { harness, input } = await harnessWithNodes()
    harness.failNextStart.error = codedError('executor.start_failed')
    await expect(harness.service.createLink(USER, input)).rejects.toMatchObject({
      code: 'orch.executor_unavailable',
    })
    expect([...harness.links.rows.values()][0]).toMatchObject({
      state: 'closed',
      closeReason: 'spawn_failed',
    })
    expect(harness.tuiRelaunches).toEqual([])
  })
})
