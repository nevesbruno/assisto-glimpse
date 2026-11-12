// @vitest-environment node
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { serveAgentRuntimeEvents } from '../../../src/app/main/controlSurface/http/agentRuntimeSse'
import { AgentRunStateRegistry } from '../../../src/contexts/agent/application/AgentRunStateRegistry'

afterEach(() => {
  vi.useRealTimers()
})

it('writes heartbeat comments on an idle agent stream and stops after close', () => {
  vi.useFakeTimers()
  const registry = new AgentRunStateRegistry({
    epoch: 'worker',
    now: () => 1,
    createTurnId: () => 't',
    schedule: () => () => {},
    retention: 3,
  })
  const res = Object.assign(new EventEmitter(), {
    output: '',
    destroyed: false,
    writableEnded: false,
    writeHead: () => {},
    write(chunk: string) {
      this.output += chunk
      return true
    },
  })
  serveAgentRuntimeEvents({
    req: new EventEmitter() as IncomingMessage,
    res: res as unknown as ServerResponse,
    url: new URL('http://localhost/events?stream=agent'),
    registry,
    clients: new Set(),
    listenerClients: new Set(),
  })
  const opened = res.output.length
  vi.advanceTimersByTime(60_000)
  expect(res.output.slice(opened)).toMatch(/^(:\n\n){2,}$/)

  res.emit('close')
  const closed = res.output.length
  vi.advanceTimersByTime(60_000)
  expect(res.output.length).toBe(closed)
  expect(vi.getTimerCount()).toBe(0)
  registry.dispose()
})
