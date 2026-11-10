import { describe, expect, it, vi } from 'vitest'
import { PtyStreamHub } from '../../../src/app/main/controlSurface/ptyStream/ptyStreamHub'

function fixture() {
  const clock = { now: 1_000 }
  const write = vi.fn()
  const hub = new PtyStreamHub({
    replayWindowMaxBytes: 64_000,
    now: () => clock.now,
    ptyRuntime: {
      spawnSession: vi.fn(),
      write,
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    },
  })
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  }
  hub.registerClient({ clientId: 'writer', kind: 'web', ws: ws as never })
  hub.registerSessionMetadata({
    sessionId: 's1',
    kind: 'terminal',
    startedAt: '2026-11-10T00:00:00.000Z',
    cwd: '/tmp',
    command: 'zsh',
    args: [],
    cols: 80,
    rows: 24,
  })
  hub.attach({ clientId: 'writer', sessionId: 's1', role: 'controller' })
  return { hub, clock, write }
}

describe('PtyStreamHub input watermark (U-06)', () => {
  it('is null before any typing', () => {
    expect(fixture().hub.inputWatermark('s1')).toBeNull()
  })

  it('records the time of the last typed write reaching the PTY', async () => {
    const { hub, clock, write } = fixture()
    clock.now = 5_000
    hub.write({ clientId: 'writer', sessionId: 's1', data: 'ls' })
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('s1', 'ls'))
    expect(hub.inputWatermark('s1')).toBe(5_000)
    clock.now = 9_000
    hub.write({ clientId: 'writer', sessionId: 's1', data: 'x' })
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(hub.inputWatermark('s1')).toBe(9_000)
  })

  it('does not count a delivery paste as typing', async () => {
    const { hub, write } = fixture()
    await hub.writeAutomation({
      sessionId: 's1',
      data: 'pasted',
      assertActive: () => undefined,
      validateBinding: async () => undefined,
    })
    expect(write).toHaveBeenCalledWith('s1', 'pasted')
    expect(hub.inputWatermark('s1')).toBeNull()
  })
})
