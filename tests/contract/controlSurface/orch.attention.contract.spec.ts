import { describe, expect, it } from 'vitest'
import { orchAttentionOperations } from '../../../src/shared/contracts/controlSurface/operations/domains/orchAttention'
import { orchOperations } from '../../../src/shared/contracts/controlSurface/operations/domains/orch'
import {
  APP_ERROR_CODES,
  ORCHESTRATION_ERROR_CODES,
  orchestrationAttentionResultSchema,
  orchestrationPendingApprovalSchema,
  orchestrationPendingHookSchema,
} from '../../../src/shared/contracts/dto'

const [list] = orchAttentionOperations
const byId = Object.fromEntries(orchAttentionOperations.map(op => [op.id, op]))

const approval = {
  requestId: 'req-1',
  kind: 'command',
  summary: 'rm -rf build',
  turnRef: 'turn-1',
}
const hook = {
  key: 'k1',
  event: 'PreToolUse',
  origin: '/home/u/hook.sh',
  currentHash: 'hash-1',
}

describe('orch.approval.list contract', () => {
  it('is one query, interact scope, always available', () => {
    expect(orchAttentionOperations.map(op => op.id)).toEqual(['orch.approval.list'])
    expect(list).toMatchObject({
      kind: 'query',
      scope: 'interact',
      availability: 'always',
      contract: 'schema',
    })
    expect(list.summary).toContain('approval')
  })

  it('stays outside the twelve orch operations and only declares registered errors', () => {
    expect(orchOperations).toHaveLength(12)
    expect(orchOperations.map(op => op.id)).not.toContain('orch.approval.list')
    for (const code of ORCHESTRATION_ERROR_CODES) {
      expect(APP_ERROR_CODES).toContain(code)
    }
    for (const code of list.errors) {
      expect(['orch.forbidden', 'orch.not_linked']).toContain(code)
    }
  })

  it('accepts an optional executor target and refuses anything else', () => {
    expect(byId['orch.approval.list'].input.safeParse({}).success).toBe(true)
    expect(byId['orch.approval.list'].input.safeParse({ executorNodeId: 'exec-1' }).success).toBe(
      true,
    )
    expect(byId['orch.approval.list'].input.safeParse({ to: 'exec-1' }).success).toBe(false)
    expect(byId['orch.approval.list'].input.safeParse({ executorNodeId: '  ' }).success).toBe(false)
  })

  it('bounds the approval summary at 500 characters and keeps turnRef nullable', () => {
    expect(orchestrationPendingApprovalSchema.safeParse(approval).success).toBe(true)
    expect(
      orchestrationPendingApprovalSchema.safeParse({ ...approval, summary: 'x'.repeat(500) })
        .success,
    ).toBe(true)
    expect(
      orchestrationPendingApprovalSchema.safeParse({ ...approval, summary: 'x'.repeat(501) })
        .success,
    ).toBe(false)
    expect(
      orchestrationPendingApprovalSchema.safeParse({ ...approval, turnRef: null }).success,
    ).toBe(true)
    expect(orchestrationPendingApprovalSchema.safeParse({ ...approval, extra: true }).success).toBe(
      false,
    )
  })

  it('carries the exact hook pair key and hash', () => {
    expect(orchestrationPendingHookSchema.safeParse(hook).success).toBe(true)
    for (const field of ['key', 'currentHash']) {
      expect(orchestrationPendingHookSchema.safeParse({ ...hook, [field]: '' }).success).toBe(false)
    }
    expect(orchestrationPendingHookSchema.safeParse({ ...hook, hash: 'x' }).success).toBe(false)
  })

  it('fixes the result shape as a strict object with strict links', () => {
    const result = {
      linksRevision: 3,
      links: [{ executorNodeId: 'exec-1', approvals: [approval], hooks: [hook] }],
    }
    expect(orchestrationAttentionResultSchema.safeParse(result).success).toBe(true)
    expect(
      orchestrationAttentionResultSchema.safeParse({
        ...result,
        links: [{ ...result.links[0], attention: 1 }],
      }).success,
    ).toBe(false)
    expect(
      orchestrationAttentionResultSchema.safeParse({ ...result, linksRevision: -1 }).success,
    ).toBe(false)
    expect(orchestrationAttentionResultSchema.safeParse({ ...result, extra: true }).success).toBe(
      false,
    )
  })
})
