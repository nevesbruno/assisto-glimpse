import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSseHeartbeat } from '../../../src/app/main/controlSurface/http/sseHeartbeat'

function createResponse() {
  const res = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>
    destroyed: boolean
    writableEnded: boolean
  }
  res.write = vi.fn(() => true)
  res.destroyed = false
  res.writableEnded = false
  return res
}

describe('sse heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes a comment frame on an idle stream and stops after close', () => {
    vi.useFakeTimers()
    const res = createResponse()
    startSseHeartbeat(res as unknown as ServerResponse, 15_000)

    expect(res.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(45_000)
    expect(res.write).toHaveBeenCalledTimes(3)
    expect(res.write).toHaveBeenCalledWith(':\n\n')

    res.emit('close')
    vi.advanceTimersByTime(60_000)
    expect(res.write).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not keep the process alive', () => {
    const unref = vi.spyOn(globalThis, 'setInterval')
    const res = createResponse()
    startSseHeartbeat(res as unknown as ServerResponse)
    const timer = unref.mock.results[0]?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
    res.emit('close')
    unref.mockRestore()
  })
})
