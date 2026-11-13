import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promptDeliveryRuntimeFixture } from '../../support/promptDeliveryRuntimeFixture'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('prompt delivery after a crash restart (wave 6 R1)', () => {
  it('admits the resumed orchestrator from its provider SessionStart and writes the notice', async () => {
    const f = promptDeliveryRuntimeFixture(undefined, 'claude-code', false)

    f.runtime.metadata({ sessionId: 's', resumeSessionId: 'provider-thread' })

    const result = f.deliver().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.write.mock.calls.some(call => call[1] === '\x1b[200~prompt\x1b[201~')).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.write.mock.calls.some(call => call[1] === '\r')).toBe(true)

    f.dispose()
    expect((await result).code).toBe('agent.prompt_stalled')
  })
})
