import { describe, expect, it } from 'vitest'
import { orchestrationAttentionResultSchema } from '../../../../../src/shared/contracts/dto/orchestrationAttention'
import { orchestratorPrincipal, spawnedHarness, USER } from './fakes'

const H1 = { key: 'k1', event: 'PreToolUse', origin: '/home/u/hook.sh', currentHash: 'hash-1' }
const H2 = { key: 'k2', event: 'Stop', origin: '/home/u/stop.sh', currentHash: 'hash-2' }

async function withPendingApproval(summary = 'rm -rf build') {
  const spawned = await spawnedHarness()
  spawned.runtime.knownApprovals.add('req-1')
  spawned.runtime.emit({
    type: 'approval.requested',
    requestId: 'req-1',
    kind: 'command',
    summary,
    turnRef: 'turn-1',
  })
  await spawned.harness.service.whenIdle()
  return spawned
}

describe('pending attention', () => {
  it('lists the held approval with its identity, kind, summary and turn, and no hooks', async () => {
    const spawned = await withPendingApproval()

    const result = await spawned.harness.service.pendingAttention(USER, {})

    expect(result).toEqual({
      linksRevision: spawned.harness.links.revision,
      links: [
        {
          executorNodeId: spawned.executorNodeId,
          approvals: [
            {
              requestId: 'req-1',
              kind: 'command',
              summary: 'rm -rf build',
              turnRef: 'turn-1',
            },
          ],
          hooks: [],
        },
      ],
    })
  })

  it('cuts the summary to 500 characters and keeps the turn reference nullable', async () => {
    const spawned = await withPendingApproval('x'.repeat(600))
    spawned.runtime.emit({
      type: 'approval.requested',
      requestId: 'req-2',
      kind: 'file',
      summary: 'write',
      turnRef: null,
    })
    await spawned.harness.service.whenIdle()

    const [link] = (await spawned.harness.service.pendingAttention(USER, {})).links

    expect(link.approvals[0].summary).toHaveLength(500)
    expect(link.approvals[1]).toEqual(
      expect.objectContaining({ requestId: 'req-2', summary: 'write', turnRef: null }),
    )

    const emoji = await withPendingApproval('😀'.repeat(400))
    const cut = await emoji.harness.service.pendingAttention(USER, {})
    expect(cut.links[0].approvals[0].summary.length).toBeLessThanOrEqual(500)
    expect(orchestrationAttentionResultSchema.safeParse(cut).success).toBe(true)
  })

  it('lists only the hooks still missing an approval for the exact pair key and hash', async () => {
    const spawned = await spawnedHarness()
    spawned.runtime.emit({ type: 'hooks.trust_pending', hooks: [H1, H2] })
    await spawned.harness.service.whenIdle()
    await spawned.harness.service.approveHooks(USER, {
      executorNodeId: spawned.executorNodeId,
      keys: ['k1'],
    })
    await spawned.harness.service.whenIdle()

    const [link] = (await spawned.harness.service.pendingAttention(USER, {})).links
    expect(link.hooks).toEqual([H2])

    spawned.harness.runtimes
      .get(spawned.executorNodeId)!
      .emit({ type: 'hooks.trust_pending', hooks: [{ ...H1, currentHash: 'hash-9' }, H2] })
    await spawned.harness.service.whenIdle()
    expect((await spawned.harness.service.pendingAttention(USER, {})).links[0].hooks).toEqual([
      { ...H1, currentHash: 'hash-9' },
      H2,
    ])
  })

  it('a single approved hook leaves both the read and the status count empty', async () => {
    const spawned = await spawnedHarness()
    spawned.runtime.emit({ type: 'hooks.trust_pending', hooks: [H1] })
    await spawned.harness.service.whenIdle()

    await spawned.harness.service.approveHooks(USER, {
      executorNodeId: spawned.executorNodeId,
      keys: ['k1'],
    })
    await spawned.harness.service.whenIdle()

    expect((await spawned.harness.service.pendingAttention(USER, {})).links[0].hooks).toEqual([])
    const status = await spawned.harness.service.status(USER, { to: spawned.executorNodeId })
    expect(status.links[0].pendingHooks).toBe(0)
  })

  it('the user sees every visible link; a target narrows the answer to that executor', async () => {
    const first = await withPendingApproval()
    const second = await first.harness.service.spawn(orchestratorPrincipal(), {
      requestId: '22222222-2222-4222-8222-222222222222',
      provider: 'codex',
    })
    await first.harness.service.whenIdle()

    const all = await first.harness.service.pendingAttention(USER, {})
    expect(all.links.map(link => link.executorNodeId).sort()).toEqual(
      [first.executorNodeId, second.executorNodeId].sort(),
    )

    const one = await first.harness.service.pendingAttention(USER, {
      executorNodeId: second.executorNodeId,
    })
    expect(one.links.map(link => link.executorNodeId)).toEqual([second.executorNodeId])
  })

  it('an agent without a target gets orch.not_linked and one with its own link sees only it', async () => {
    const spawned = await withPendingApproval()
    const orchestrator = orchestratorPrincipal()

    await expect(spawned.harness.service.pendingAttention(orchestrator, {})).rejects.toMatchObject({
      code: 'orch.not_linked',
    })

    const own = await spawned.harness.service.pendingAttention(orchestrator, {
      executorNodeId: spawned.executorNodeId,
    })
    expect(own.links.map(link => link.executorNodeId)).toEqual([spawned.executorNodeId])
  })

  it('refuses an executor of an active link and an unlinked target', async () => {
    const spawned = await withPendingApproval()

    await expect(
      spawned.harness.service.pendingAttention(orchestratorPrincipal(spawned.executorNodeId), {}),
    ).rejects.toMatchObject({ code: 'orch.forbidden' })
    await expect(
      spawned.harness.service.pendingAttention(USER, { executorNodeId: 'ghost' }),
    ).rejects.toMatchObject({ code: 'orch.not_linked' })
  })

  it('empties the approvals after the request is answered', async () => {
    const spawned = await withPendingApproval()
    await spawned.harness.service.respondApproval(USER, {
      executorNodeId: spawned.executorNodeId,
      requestId: 'req-1',
      decision: 'accept',
    })

    expect((await spawned.harness.service.pendingAttention(USER, {})).links[0].approvals).toEqual(
      [],
    )
  })
})
