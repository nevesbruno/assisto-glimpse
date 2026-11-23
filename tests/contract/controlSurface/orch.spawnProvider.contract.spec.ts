import { describe, expect, it } from 'vitest'
import { orchSpawnOperation } from '../../../src/shared/contracts/controlSurface/operations/domains/orch'

const requestId = '7f3a2c1e-5b4d-4e6f-8a9b-0c1d2e3f4a5b'
const parse = (provider: unknown) =>
  orchSpawnOperation.input.safeParse({ requestId, provider }).success

describe('orch.spawn provider contract (F3-01)', () => {
  it('accepts codex and opencode', () => {
    expect(parse('codex')).toBe(true)
    expect(parse('opencode')).toBe(true)
  })

  it('refuses every other provider and a missing one', () => {
    for (const provider of ['claude-code', 'gemini', 'terminal', '', null, 1]) {
      expect(parse(provider)).toBe(false)
    }
    expect(orchSpawnOperation.input.safeParse({ requestId }).success).toBe(false)
  })

  it('keeps the rest of the spawn input strict', () => {
    expect(
      orchSpawnOperation.input.safeParse({ requestId, provider: 'opencode', extra: true }).success,
    ).toBe(false)
    expect(
      orchSpawnOperation.input.safeParse({
        requestId,
        provider: 'opencode',
        prompt: 'a\u0000b',
      }).success,
    ).toBe(false)
  })

  it('describes the provider as the executor runtime, not as a phase-2 exclusive', () => {
    expect(orchSpawnOperation.input.shape.provider.description ?? '').not.toMatch(/only codex/i)
  })
})
