import { describe, expect, it } from 'vitest'
import { ORCHESTRATOR_PROVIDER } from '../../../../../src/contexts/orchestration/domain/agentLink'
import { orchestrationSpawnResultSchema } from '../../../../../src/shared/contracts/dto/orchestration'
import {
  bootedHarness,
  codedError,
  orchestratorPrincipal,
  SPAWN_REQUEST_ID,
  spawnedHarness,
  USER,
  uuidFrom,
} from './fakes'

const orq = orchestratorPrincipal()

describe('spawnExecutor (U-02)', () => {
  it('T2: two orchestrators with the same requestId get two distinct initial dispatches', async () => {
    const harness = await bootedHarness()
    harness.nodes.set('orq2', { nodeId: 'orq2', provider: ORCHESTRATOR_PROVIDER, title: 'orq2' })
    const first = await harness.service.spawn(orq, {
      requestId: SPAWN_REQUEST_ID,
      provider: 'codex',
      prompt: 'start here',
    })
    const second = await harness.service.spawn(USER, {
      requestId: SPAWN_REQUEST_ID,
      provider: 'codex',
      prompt: 'start here',
      orchestratorNodeId: 'orq2',
    })
    expect(second.duplicate).toBe(false)
    expect(first.dispatch?.dispatchId).toBe(uuidFrom(`orq:${SPAWN_REQUEST_ID}`))
    expect(second.dispatch?.dispatchId).toBe(uuidFrom(`orq2:${SPAWN_REQUEST_ID}`))
    expect(harness.dispatches.rows.size).toBe(2)
  })

  it('T3: a prompt over 32768 bytes fails before any node, link or service exists', async () => {
    const harness = await bootedHarness()
    const nodes = harness.nodes.size
    await expect(
      harness.service.spawn(orq, {
        requestId: SPAWN_REQUEST_ID,
        provider: 'codex',
        prompt: 'a'.repeat(32_769),
      }),
    ).rejects.toMatchObject({ code: 'invalid_text' })
    expect(harness.nodes.size).toBe(nodes)
    expect(harness.links.rows.size).toBe(0)
    expect(harness.starts).toHaveLength(0)
  })

  it('T4: a link left without its first dispatch gets it on the resend and the pump sends it', async () => {
    const harness = await bootedHarness()
    const first = await harness.service.spawn(orq, {
      requestId: SPAWN_REQUEST_ID,
      provider: 'codex',
    })
    await harness.service.whenIdle()
    const again = await harness.service.spawn(orq, {
      requestId: SPAWN_REQUEST_ID,
      provider: 'codex',
      prompt: 'start here',
    })
    expect(again).toMatchObject({
      duplicate: true,
      linkId: first.linkId,
      dispatch: { dispatchId: uuidFrom(`orq:${SPAWN_REQUEST_ID}`), state: 'queued', round: 1 },
    })
    await harness.service.whenIdle()
    expect(harness.dispatches.rows.get(uuidFrom(`orq:${SPAWN_REQUEST_ID}`))?.state).toBe('sent')
    expect(harness.runtimes.get(first.executorNodeId)?.startedTurns).toHaveLength(1)
  })

  it('creates the node, the link and the service, and launches the TUI', async () => {
    const { harness, result } = await spawnedHarness()
    expect(orchestrationSpawnResultSchema.parse(result)).toBeTruthy()
    expect(result).toMatchObject({ duplicate: false, dispatch: null, runtimeMode: 'service' })
    expect(result.admission).toMatchObject({ canDispatch: true, willWait: false })
    expect(harness.starts[0]).toMatchObject({
      provider: 'codex',
      cwd: '/work',
      policy: { approvals: 'user' },
    })
    expect(harness.tuiLaunches).toEqual([result.executorNodeId])
    const link = [...harness.links.rows.values()][0]
    expect(link).toMatchObject({
      spawnRequestId: SPAWN_REQUEST_ID,
      state: 'active',
      executorSessionRef: `session-of-${result.executorNodeId}`,
    })
  })

  it('the initial dispatch id is the uuid v5 of the orchestrator and the requestId', async () => {
    const { harness, result } = await spawnedHarness('start here')
    expect(result.dispatch).toMatchObject({
      dispatchId: uuidFrom(`orq:${SPAWN_REQUEST_ID}`),
      state: 'queued',
      round: 1,
    })
    expect(orchestrationSpawnResultSchema.parse(result)).toBeTruthy()
    expect(harness.dispatches.rows.get(uuidFrom(`orq:${SPAWN_REQUEST_ID}`))?.state).toBe('sent')
  })

  it('the same requestId returns the existing link with duplicate and creates nothing new', async () => {
    const { harness, result } = await spawnedHarness('start here')
    const nodes = harness.nodes.size
    const again = await harness.service.spawn(orq, {
      requestId: SPAWN_REQUEST_ID,
      provider: 'codex',
      prompt: 'start here',
    })
    expect(again).toMatchObject({
      duplicate: true,
      linkId: result.linkId,
      executorNodeId: result.executorNodeId,
      dispatch: { dispatchId: uuidFrom(`orq:${SPAWN_REQUEST_ID}`), state: 'sent' },
    })
    expect(orchestrationSpawnResultSchema.parse(again)).toBeTruthy()
    expect(harness.nodes.size).toBe(nodes)
    expect(harness.starts).toHaveLength(1)
    expect(harness.dispatches.insertCalls).toBe(1)
  })

  it('a failing service start closes the link as spawn_failed and reports the executor as unavailable', async () => {
    const harness = await bootedHarness()
    harness.failNextStart.error = codedError('executor.start_failed')
    await expect(
      harness.service.spawn(orq, { requestId: SPAWN_REQUEST_ID, provider: 'codex' }),
    ).rejects.toMatchObject({ code: 'orch.executor_unavailable' })
    expect([...harness.links.rows.values()][0]).toMatchObject({
      state: 'closed',
      closeReason: 'spawn_failed',
    })
  })

  it('an incompatible service version is orch.protocol_mismatch before any node exists', async () => {
    const harness = await bootedHarness()
    harness.probe.compatible = false
    await expect(
      harness.service.spawn(orq, { requestId: SPAWN_REQUEST_ID, provider: 'codex' }),
    ).rejects.toMatchObject({ code: 'orch.protocol_mismatch' })
    expect(harness.nodes.size).toBe(1)
  })

  it('the user must name the orchestrator and an agent cannot choose another one', async () => {
    const harness = await bootedHarness()
    await expect(
      harness.service.spawn(USER, { requestId: SPAWN_REQUEST_ID, provider: 'codex' }),
    ).rejects.toMatchObject({ code: 'orch.link_invalid' })
    const viaUser = await harness.service.spawn(USER, {
      requestId: SPAWN_REQUEST_ID,
      provider: 'codex',
      orchestratorNodeId: 'orq',
    })
    expect(viaUser.duplicate).toBe(false)
    const other = await harness.service.spawn(orq, {
      requestId: uuidFrom('other'),
      provider: 'codex',
      orchestratorNodeId: 'someone-else',
    })
    expect([...harness.links.rows.values()].at(-1)?.orchestratorNodeId).toBe('orq')
    expect(other.duplicate).toBe(false)
  })
})
