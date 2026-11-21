// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  OPEN_CODE_RECONNECT_DELAYS_MS,
  OpenCodeHttpClient,
  type OpenCodeClientState,
} from '../../../../../src/contexts/orchestration/infrastructure/opencode/OpenCodeHttpClient'

const PASSWORD = 'pw-secret'
const BASE = 'http://127.0.0.1:4400'

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** A response whose body delivers the chunks as they are pushed, for SSE tests. */
function streamResponse(chunks: string[]): {
  response: Response
  push: (text: string) => void
  end: () => void
} {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(inner) {
      controller = inner
      for (const chunk of chunks) {
        inner.enqueue(encoder.encode(chunk))
      }
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    push: text => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  }
}

describe('OpenCodeHttpClient (F3-01)', () => {
  it('sends the Basic credential of the serve process as opencode:<password>', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return json({ data: { id: 'ses_1' } })
      }) as unknown as typeof fetch,
    })
    const result = await client.get('/api/session/ses_1')
    expect(result).toEqual({ status: 200, body: { data: { id: 'ses_1' } } })
    expect(calls[0].url).toBe(`${BASE}/api/session/ses_1`)
    const header = new Headers(calls[0].init.headers).get('authorization')
    expect(header).toBe(`Basic ${Buffer.from(`opencode:${PASSWORD}`, 'utf8').toString('base64')}`)
  })

  it('posts JSON and keeps the status for the caller to judge', async () => {
    const calls: { body: unknown; contentType: string | null }[] = []
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls.push({
          body: JSON.parse(String(init.body)),
          contentType: new Headers(init.headers).get('content-type'),
        })
        return json({ _tag: 'InvalidRequestError' }, 400)
      }) as unknown as typeof fetch,
    })
    const result = await client.post('/api/session/ses_1/prompt', { id: 'msg_1', text: 'hi' })
    expect(result.status).toBe(400)
    expect(calls[0]).toEqual({
      body: { id: 'msg_1', text: 'hi' },
      contentType: 'application/json',
    })
  })

  it('fails a read with executor.unavailable when the service does not answer', async () => {
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    await expect(client.get('/api/session')).rejects.toMatchObject({
      code: 'executor.unavailable',
    })
  })

  it('fails a write that got no response with executor.send_uncertain', async () => {
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      requestTimeoutMs: 10,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        })) as unknown as typeof fetch,
    })
    await expect(
      client.post('/api/session/ses_1/prompt', { id: 'msg_1', text: 'hi' }),
    ).rejects.toMatchObject({ code: 'executor.send_uncertain' })
  })

  it('parses an SSE stream across chunks and ignores heartbeat comments', async () => {
    const stream = streamResponse([
      ': heartbeat\n\n',
      'data: {"id":"e1","type":"server.connected","data":{}}\n\n',
      'data: {"id":"e2","type":"session.execution.started","data":{"sess',
    ])
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      fetchImpl: (async () => stream.response) as unknown as typeof fetch,
    })
    const events: unknown[] = []
    client.onEvent(event => events.push(event))
    await client.connect()
    stream.push('ionID":"ses_1"}}\n\n')
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]).toEqual({
      id: 'e2',
      type: 'session.execution.started',
      data: { sessionID: 'ses_1' },
    })
    client.close()
  })

  it('reconnects on the 1, 2 and 4 s schedule and reports the state changes', async () => {
    expect(OPEN_CODE_RECONNECT_DELAYS_MS).toEqual([1000, 2000, 4000])
    const attempts: number[] = []
    const closed = streamResponse([])
    const open = streamResponse([])
    const states: string[] = []
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      reconnectDelayMs: attempt => {
        attempts.push(attempt)
        return 0
      },
      fetchImpl: (async () => {
        const response = attempts.length === 0 ? closed.response : open.response
        return response
      }) as unknown as typeof fetch,
    })
    client.onStateChange((state: OpenCodeClientState) => states.push(state))
    await client.connect()
    closed.end()
    await vi.waitFor(() => expect(attempts).toEqual([1]))
    await vi.waitFor(() => expect(states).toEqual(['connected', 'reconnecting', 'connected']))
    client.close()
  })

  it('gives up after the reconnect budget and closes the stream', async () => {
    const attempts: number[] = []
    const closed = streamResponse([])
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      reconnectDelayMs: attempt => {
        attempts.push(attempt)
        return 0
      },
      fetchImpl: (async () => {
        if (attempts.length === 0) {
          return closed.response
        }
        throw new TypeError('connection refused')
      }) as unknown as typeof fetch,
    })
    const states: string[] = []
    client.onStateChange((state, reason?: string) => states.push(reason ?? state))
    await client.connect()
    closed.end()
    await vi.waitFor(() => expect(attempts).toEqual([1, 2, 3]))
    await vi.waitFor(() => expect(states.at(-1)).toBe('reconnect_exhausted'))
    expect(client.currentState).toBe('closed')
  })

  it('ignores a data line that is not JSON without dropping the stream', async () => {
    const stream = streamResponse([
      'data: not-json\n\n',
      'data: {"id":"e1","type":"server.connected","data":{}}\n\n',
    ])
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      fetchImpl: (async () => stream.response) as unknown as typeof fetch,
    })
    const events: unknown[] = []
    client.onEvent(event => events.push(event))
    await client.connect()
    await vi.waitFor(() => expect(events).toHaveLength(1))
    client.close()
  })

  it('stops reconnecting after close', async () => {
    const stream = streamResponse([])
    const delays: number[] = []
    const client = new OpenCodeHttpClient({
      url: BASE,
      password: PASSWORD,
      reconnectDelayMs: attempt => {
        delays.push(attempt)
        return 1000
      },
      fetchImpl: (async () => stream.response) as unknown as typeof fetch,
    })
    await client.connect()
    client.close()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(delays).toEqual([])
    expect(client.currentState).toBe('closed')
  })
})
