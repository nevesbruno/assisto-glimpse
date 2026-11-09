import { describe, expect, it } from 'vitest'
import { orchOperations } from '../../../src/shared/contracts/controlSurface/operations/domains/orch'
import {
  APP_ERROR_CODES,
  ORCHESTRATION_ERROR_CODES,
  orchestrationLinkDtoSchema,
} from '../../../src/shared/contracts/dto'

const uuid = '7f3a2c1e-5b4d-4e6f-8a9b-0c1d2e3f4a5b'
const byId = Object.fromEntries(orchOperations.map(op => [op.id, op]))

const matrix: Record<string, 'read' | 'interact' | 'admin'> = {
  'orch.spawn': 'interact',
  'orch.dispatch': 'interact',
  'orch.status': 'interact',
  'orch.cancel': 'interact',
  'orch.interrupt': 'interact',
  'orch.close': 'interact',
  'orch.link.list': 'read',
  'orch.link.create': 'admin',
  'orch.link.close': 'admin',
  'orch.link.extend': 'admin',
  'orch.approval.respond': 'admin',
  'orch.hooks.approve': 'admin',
}

const queries = new Set(['orch.status', 'orch.link.list'])

describe('orch.* operations contract (C-02)', () => {
  it('declares the twelve operations with the matrix scopes, kind and availability', () => {
    expect(orchOperations.map(op => op.id).sort()).toEqual(Object.keys(matrix).sort())
    for (const op of orchOperations) {
      expect(op.scope).toBe(matrix[op.id])
      expect(op.contract).toBe('schema')
      expect(op.availability).toBe('always')
      expect(op.kind).toBe(queries.has(op.id) ? 'query' : 'command')
    }
  })

  it('declares only registered error codes', () => {
    for (const code of ORCHESTRATION_ERROR_CODES) {
      expect(APP_ERROR_CODES).toContain(code)
    }
    for (const op of orchOperations) {
      for (const code of op.errors) {
        expect(code.startsWith('orch.')).toBe(true)
      }
    }
  })

  it('bounds text to 1..32768 UTF-8 bytes and refuses controls', () => {
    const dispatch = (text: string) =>
      byId['orch.dispatch'].input.safeParse({ dispatchId: uuid, to: 'exec', text }).success
    expect(dispatch('a')).toBe(true)
    expect(dispatch('linha\n\tdois')).toBe(true)
    expect(dispatch('a'.repeat(32_768))).toBe(true)
    expect(dispatch('a'.repeat(32_769))).toBe(false)
    expect(dispatch('é'.repeat(16_385))).toBe(false)
    expect(dispatch('')).toBe(false)
    expect(dispatch('a\u0000b')).toBe(false)
    expect(dispatch('a\u001b[31mb')).toBe(false)
    expect(dispatch('a\uD800b')).toBe(false)
    expect(
      byId['orch.spawn'].input.safeParse({
        requestId: uuid,
        provider: 'codex',
        prompt: 'a'.repeat(32_769),
      }).success,
    ).toBe(false)
  })

  it('describes orch.status by admission, not by queue', () => {
    expect(byId['orch.status'].summary).toContain('admission')
    expect(byId['orch.status'].summary).not.toMatch(/queue/i)
  })

  it('requires uuid ids and strict objects', () => {
    const ok = { dispatchId: uuid, to: 'exec', text: 'x' }
    expect(byId['orch.dispatch'].input.safeParse(ok).success).toBe(true)
    expect(byId['orch.dispatch'].input.safeParse({ ...ok, dispatchId: 'nope' }).success).toBe(false)
    expect(byId['orch.dispatch'].input.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    expect(byId['orch.dispatch'].input.safeParse({ ...ok, allowRepeat: true }).success).toBe(false)
    expect(byId['orch.cancel'].input.safeParse({ dispatchId: 'nope' }).success).toBe(false)
    expect(
      byId['orch.spawn'].input.safeParse({ requestId: 'nope', provider: 'codex' }).success,
    ).toBe(false)
    expect(
      byId['orch.link.extend'].input.safeParse({ linkId: uuid, rounds: 3, reason: 'r' }).success,
    ).toBe(false)
  })

  it('carries kind, state and health in the link DTO', () => {
    const link = {
      id: uuid,
      projectId: 'p',
      spaceId: 's',
      orchestratorNodeId: 'a',
      executorNodeId: 'b',
      kind: 'executor',
      origin: 'orchestrator_spawn',
      runtimeMode: 'service',
      provider: 'codex',
      state: 'active',
      closeReason: null,
      health: 'ready',
      roundsUsed: 0,
      roundsLimit: 3,
      createdAt: 't',
      updatedAt: 't',
      revision: 0,
    }
    expect(orchestrationLinkDtoSchema.safeParse(link).success).toBe(true)
    for (const field of ['kind', 'state', 'health']) {
      expect(orchestrationLinkDtoSchema.safeParse({ ...link, [field]: undefined }).success).toBe(
        false,
      )
    }
  })
})
