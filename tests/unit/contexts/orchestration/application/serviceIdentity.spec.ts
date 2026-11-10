import { describe, expect, it } from 'vitest'
import { bootedHarness, sha256, spawnedHarness } from './fakes'

const recoveredEvent = { type: 'executor.recovered', sessionRef: 's' } as const

describe('service identity of the executor link (F2-14 2b)', () => {
  it('records pid and token hash after the service starts', async () => {
    const { harness, linkId, executorNodeId } = await spawnedHarness()
    const link = harness.links.rows.get(linkId)!
    expect(link.servicePid).toBe(4242)
    expect(link.serviceTokenSha256).toBe(sha256(`token-of-${executorNodeId}`))
  })

  it('records the new identity when the supervisor recovers the service', async () => {
    const { harness, linkId, runtime } = await spawnedHarness()
    runtime.identity = { pid: 5000, tokenSha256: 'b'.repeat(64) }
    runtime.emit(recoveredEvent)
    await harness.service.whenIdle()
    const link = harness.links.rows.get(linkId)!
    expect(link.servicePid).toBe(5000)
    expect(link.serviceTokenSha256).toBe('b'.repeat(64))
  })

  it('does not write again when the identity is the same', async () => {
    const { harness, linkId, runtime } = await spawnedHarness()
    const before = harness.links.rows.get(linkId)!.revision
    runtime.emit(recoveredEvent)
    await harness.service.whenIdle()
    expect(harness.links.rows.get(linkId)!.revision).toBe(before)
  })

  it('keeps the spawn working when reading the identity fails', async () => {
    const harness = await bootedHarness()
    harness.hooks.onRuntimeStart = runtime => {
      runtime.identityError = new Error('boom')
    }
    const result = await harness.service.spawn(
      { kind: 'user' },
      {
        requestId: '22222222-2222-4222-8222-222222222222',
        provider: 'codex',
        orchestratorNodeId: 'orq',
      },
    )
    const link = harness.links.rows.get(result.linkId)!
    expect(link.state).toBe('active')
    expect(link.servicePid).toBeNull()
  })

  it('keeps the spawn working when the null identity means no live service', async () => {
    const harness = await bootedHarness()
    harness.hooks.onRuntimeStart = runtime => {
      runtime.identity = null
    }
    const result = await harness.service.spawn(
      { kind: 'user' },
      {
        requestId: '33333333-3333-4333-8333-333333333333',
        provider: 'codex',
        orchestratorNodeId: 'orq',
      },
    )
    expect(harness.links.rows.get(result.linkId)!.servicePid).toBeNull()
  })
})
