/* oxlint-disable no-await-in-loop */
import { describe, expect, it } from 'vitest'
import type { OrchestrationPrincipal } from '../../../../../src/contexts/orchestration/domain/orchestrationAuthorization'
import { orchestratorPrincipal, spawnedHarness, USER, uuidFrom } from './fakes'

const D1 = uuidFrom('auth-1')
const orq = orchestratorPrincipal()
const otherOrq = orchestratorPrincipal('orq-2')
const plainWindow: OrchestrationPrincipal = {
  ...orchestratorPrincipal('window'),
  provider: 'codex',
}

async function setup() {
  const spawned = await spawnedHarness()
  const { harness, executorNodeId } = spawned
  await harness.service.dispatch(orq, { dispatchId: D1, to: executorNodeId, text: 'x' })
  await harness.service.whenIdle()
  const executor: OrchestrationPrincipal = {
    ...orchestratorPrincipal(executorNodeId),
    provider: 'codex',
  }
  return { ...spawned, executor }
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'allowed',
    (error: { code?: string }) => error.code,
  )

describe('authorization in the application (U-09)', () => {
  it('dispatch, interrupt, close and cancel follow the matrix for each principal', async () => {
    const { harness, executorNodeId, executor } = await setup()
    const svc = harness.service
    const dispatchWith = (principal: OrchestrationPrincipal, id: string) =>
      code(svc.dispatch(principal, { dispatchId: id, to: executorNodeId, text: 't' }))
    expect(await dispatchWith(executor, uuidFrom('a'))).toBe('orch.forbidden')
    expect(await dispatchWith(plainWindow, uuidFrom('b'))).toBe('orch.forbidden')
    expect(await dispatchWith(otherOrq, uuidFrom('c'))).toBe('orch.not_linked')
    expect(await dispatchWith(orq, uuidFrom('d'))).toBe('orch.dispatch_in_flight')
    expect(await dispatchWith(USER, uuidFrom('e'))).toBe('orch.dispatch_in_flight')

    expect(await code(svc.cancel(otherOrq, { dispatchId: D1 }))).toBe('orch.not_linked')
    expect(await code(svc.cancel(executor, { dispatchId: D1 }))).toBe('orch.forbidden')
    expect(await code(svc.interrupt(otherOrq, { to: executorNodeId }))).toBe('orch.not_linked')
    expect(await code(svc.interrupt(plainWindow, { to: executorNodeId }))).toBe('orch.forbidden')
    expect(await code(svc.interrupt(orq, { to: executorNodeId }))).toBe('allowed')
    expect(await code(svc.close(otherOrq, { to: executorNodeId }))).toBe('orch.not_linked')
    expect(await code(svc.close(executor, { to: executorNodeId }))).toBe('orch.forbidden')
    expect(await code(svc.close(USER, { to: executorNodeId, force: true }))).toBe('allowed')
  })

  it('A4: a missing node and a foreign node answer the same orch.not_linked', async () => {
    const { harness } = await setup()
    const asOther = (to: string) =>
      code(harness.service.dispatch(otherOrq, { dispatchId: uuidFrom(to), to, text: 't' }))
    expect(await asOther('does-not-exist')).toBe('orch.not_linked')
    expect(await asOther('exec-1')).toBe('orch.not_linked')
    expect(await code(harness.service.status(otherOrq, { to: 'does-not-exist' }))).toBe(
      'orch.not_linked',
    )
  })

  it('status lists only the links of the caller, an empty list for other windows', async () => {
    const { harness, executor } = await setup()
    expect((await harness.service.status(orq, {})).links).toHaveLength(1)
    expect((await harness.service.status(USER, {})).links).toHaveLength(1)
    expect((await harness.service.status(otherOrq, {})).links).toEqual([])
    expect((await harness.service.status(plainWindow, {})).links).toEqual([])
    expect(await code(harness.service.status(executor, {}))).toBe('orch.forbidden')
  })

  it('spawn is open to the user and to claude-code windows only', async () => {
    const { harness, executor } = await setup()
    const spawnAs = (principal: OrchestrationPrincipal, key: string) =>
      code(
        harness.service.spawn(principal, {
          requestId: uuidFrom(key),
          provider: 'codex',
          orchestratorNodeId: 'orq',
        }),
      )
    expect(await spawnAs(executor, 'x1')).toBe('orch.forbidden')
    expect(await spawnAs(plainWindow, 'x2')).toBe('orch.forbidden')
    expect(await spawnAs(otherOrq, 'x3')).not.toBe('orch.forbidden')
  })

  it('A6: admin operations are out of reach for any agent and open to the user', async () => {
    const { harness, executor, linkId } = await setup()
    const extend = (principal: OrchestrationPrincipal) =>
      code(harness.service.extendRounds(principal, { linkId, rounds: 1 }))
    expect(await extend(orq)).toBe('orch.forbidden')
    expect(await extend(executor)).toBe('orch.forbidden')
    expect(await extend(plainWindow)).toBe('orch.forbidden')
    expect(await extend(USER)).toBe('allowed')
    expect([...harness.links.rows.values()][0].roundsLimit).toBe(4)
  })

  it('A7: agent.prompt and session.writeNode against a linked executor are orch.use_dispatch', async () => {
    const { harness, executorNodeId } = await setup()
    for (const operation of ['agent.prompt', 'session.writeNode'] as const) {
      expect(await code(harness.service.assertDirectInput(orq, operation, executorNodeId))).toBe(
        'orch.use_dispatch',
      )
      expect(
        await code(harness.service.assertDirectInput(plainWindow, operation, executorNodeId)),
      ).toBe('orch.use_dispatch')
      expect(await code(harness.service.assertDirectInput(USER, operation, executorNodeId))).toBe(
        'allowed',
      )
      expect(await code(harness.service.assertDirectInput(orq, operation, 'orq'))).toBe('allowed')
    }
  })
})
