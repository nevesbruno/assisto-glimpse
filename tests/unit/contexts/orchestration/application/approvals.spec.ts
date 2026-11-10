import { describe, expect, it } from 'vitest'
import { OrchestrationError } from '../../../../../src/contexts/orchestration/domain/agentLink'
import { codedError, orchestratorPrincipal, spawnedHarness, USER } from './fakes'

const orq = orchestratorPrincipal()

async function withPendingApproval() {
  const spawned = await spawnedHarness()
  spawned.runtime.knownApprovals.add('req-1')
  spawned.runtime.emit({
    type: 'approval.requested',
    requestId: 'req-1',
    kind: 'command',
    summary: 'rm -rf build',
    turnRef: null,
  })
  await spawned.harness.service.whenIdle()
  return spawned
}

const pendingCount = async (spawned: Awaited<ReturnType<typeof withPendingApproval>>) =>
  (await spawned.harness.service.status(USER, { to: spawned.executorNodeId })).links[0]
    .pendingApprovals

describe('executor approvals', () => {
  it('feeds the run state and the status with the request, and clears both on resolution', async () => {
    const spawned = await withPendingApproval()
    expect(spawned.harness.runState.recordWaitingForApproval).toEqual([
      [spawned.executorNodeId, 'req-1', 'rm -rf build'],
    ])
    expect(await pendingCount(spawned)).toBe(1)
    spawned.runtime.emit({ type: 'approval.resolved', requestId: 'req-1', resolvedBy: 'screen' })
    await spawned.harness.service.whenIdle()
    expect(spawned.harness.runState.recordApprovalResolved).toEqual([
      [spawned.executorNodeId, 'req-1'],
    ])
    expect(await pendingCount(spawned)).toBe(0)
  })

  it.each([
    ['accept', 'approve'],
    ['acceptForSession', 'approve_for_session'],
    ['decline', 'deny'],
    ['cancel', 'cancel'],
  ] as const)('answers %s through the port as %s', async (decision, mapped) => {
    const spawned = await withPendingApproval()
    await spawned.harness.service.respondApproval(USER, {
      executorNodeId: spawned.executorNodeId,
      requestId: 'req-1',
      decision,
    })
    expect(spawned.runtime.approvalAnswers).toEqual([{ requestId: 'req-1', decision: mapped }])
    expect(await pendingCount(spawned)).toBe(0)
  })

  it('refuses a request the service no longer has and drops it from the pending set', async () => {
    const spawned = await withPendingApproval()
    spawned.runtime.knownApprovals.clear()
    await expect(
      spawned.harness.service.respondApproval(USER, {
        executorNodeId: spawned.executorNodeId,
        requestId: 'req-1',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'orch.approval_not_found' })
    expect(await pendingCount(spawned)).toBe(0)
  })

  it('T15: an executor without a running service answers orch.executor_unavailable', async () => {
    const spawned = await withPendingApproval()
    const service = spawned.harness.restart()
    await expect(
      service.respondApproval(USER, {
        executorNodeId: spawned.executorNodeId,
        requestId: 'req-1',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'orch.executor_unavailable' })
  })

  it('T16: an executor.unavailable error of the runtime is translated', async () => {
    const spawned = await withPendingApproval()
    spawned.runtime.respondApproval = async () => {
      throw codedError('executor.unavailable')
    }
    await expect(
      spawned.harness.service.respondApproval(USER, {
        executorNodeId: spawned.executorNodeId,
        requestId: 'req-1',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'orch.executor_unavailable' })
  })

  it('refuses an executor without an active link', async () => {
    const { harness } = await spawnedHarness()
    const error = await harness.service
      .respondApproval(USER, { executorNodeId: 'ghost', requestId: 'x', decision: 'accept' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error).toMatchObject({ code: 'orch.not_linked' })
  })

  it('does not let an orchestrator agent answer for the user', async () => {
    const spawned = await withPendingApproval()
    await expect(
      spawned.harness.service.respondApproval(orq, {
        executorNodeId: spawned.executorNodeId,
        requestId: 'req-1',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'orch.forbidden' })
    expect(spawned.runtime.approvalAnswers).toHaveLength(0)
  })
})
