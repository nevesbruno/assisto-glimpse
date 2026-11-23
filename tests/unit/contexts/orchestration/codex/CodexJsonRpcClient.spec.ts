/* eslint-disable no-await-in-loop -- sequential assertions. */
// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  CodexJsonRpcClient,
  type CodexClientState,
  type CreateSocket,
} from '../../../../../src/contexts/orchestration/infrastructure/codex/CodexJsonRpcClient'

const OPEN = 1
const CLOSED = 3

type Frame = Record<string, unknown>

class FakeSocket extends EventEmitter {
  readyState = 0
  readonly frames: Frame[] = []
  sendBehavior: 'ok' | 'throw' | 'error' = 'ok'

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
    refuse: boolean,
  ) {
    super()
    setImmediate(() => {
      if (refuse) {
        this.emit('error', new Error('Unexpected server response: 401'))
        this.readyState = CLOSED
        this.emit('close')
      } else {
        this.readyState = OPEN
        this.emit('open')
      }
    })
  }

  send(text: string, callback: (error?: Error) => void): void {
    if (this.sendBehavior === 'throw') {
      throw new Error('socket exploded')
    }
    if (this.sendBehavior === 'error') {
      callback(new Error('write failed'))
      return
    }
    const frame = JSON.parse(text) as Frame
    this.frames.push(frame)
    callback()
    if (frame.method === 'initialize') {
      this.reply(frame.id as number, { userAgent: 'codex/0.167.0' })
    }
  }

  reply(id: number, result: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ id, result })))
  }

  push(message: Frame): void {
    this.emit('message', Buffer.from(JSON.stringify(message)))
  }

  close(): void {
    this.readyState = CLOSED
    this.emit('close')
  }

  drop(): void {
    this.close()
  }

  pings = 0
  pongOnPing = true

  ping(_data: unknown, _mask: unknown, callback: (error?: Error) => void): void {
    this.pings += 1
    callback()
    if (this.pongOnPing) {
      setImmediate(() => this.emit('pong'))
    }
  }

  requests(): Frame[] {
    return this.frames.filter(frame => frame.id !== undefined && frame.method !== 'initialize')
  }
}

function setup(options: { refuse?: (index: number) => boolean; requestTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const createSocket: CreateSocket = (url, headers) => {
    const socket = new FakeSocket(url, headers, options.refuse?.(sockets.length) ?? false)
    sockets.push(socket)
    return socket as never
  }
  const client = new CodexJsonRpcClient({
    url: 'ws://127.0.0.1:1',
    token: 'tok',
    createSocket,
    reconnectDelayMs: () => 1,
    requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
  })
  const states: CodexClientState[] = []
  client.onStateChange(state => states.push(state))
  return { client, sockets, states }
}

const tick = (ms = 10): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('CodexJsonRpcClient (U-08)', () => {
  it('connects with Bearer, initialize and initialized', async () => {
    const { client, sockets } = setup()
    await expect(client.connect()).resolves.toBe('codex/0.167.0')
    expect(sockets[0].headers).toEqual({ Authorization: 'Bearer tok' })
    expect(sockets[0].frames.map(frame => frame.method)).toEqual(['initialize', 'initialized'])
    expect(sockets[0].frames[0].params).toMatchObject({
      clientInfo: { name: 'glimpse-orchestration' },
    })
  })

  it('refuses the connection without a valid token as start_failed', async () => {
    const { client } = setup({ refuse: () => true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'executor.start_failed' })
  })

  it('correlates concurrent responses by id, out of order', async () => {
    const { client, sockets } = setup()
    await client.connect()
    const first = client.request('thread/start', { a: 1 })
    const second = client.request('turn/start', { b: 2 })
    await tick()
    const [one, two] = sockets[0].requests()
    sockets[0].reply(two.id as number, 'second')
    sockets[0].reply(one.id as number, 'first')
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('separates notifications from server requests and answers unknown methods with -32601', async () => {
    const { client, sockets } = setup()
    await client.connect()
    const notifications: [string, unknown][] = []
    client.onNotification((method, params) => notifications.push([method, params]))
    client.onServerRequest('item/commandExecution/requestApproval', async params => ({
      decision: 'accept',
      echo: params,
    }))
    await tick()
    sockets[0].push({ method: 'turn/started', params: { n: 1 } })
    sockets[0].push({
      id: 'srv-1',
      method: 'item/commandExecution/requestApproval',
      params: { c: 1 },
    })
    sockets[0].push({ id: 7, method: 'item/unknown/requestApproval', params: {} })
    await tick()
    expect(notifications).toEqual([['turn/started', { n: 1 }]])
    const answers = sockets[0].frames.filter(frame => frame.method === undefined)
    expect(answers).toHaveLength(2)
    expect(answers).toEqual(
      expect.arrayContaining([
        { id: 'srv-1', result: { decision: 'accept', echo: { c: 1 } } },
        {
          id: 7,
          error: { code: -32601, message: 'Method not found: item/unknown/requestApproval' },
        },
      ]),
    )
  })

  it('turns a failed write into rejected', async () => {
    const { client, sockets } = setup()
    await client.connect()
    sockets[0].sendBehavior = 'throw'
    await expect(client.request('turn/start', {})).rejects.toMatchObject({
      code: 'executor.rejected',
    })
    sockets[0].sendBehavior = 'error'
    await expect(client.request('turn/start', {})).rejects.toMatchObject({
      code: 'executor.rejected',
    })
  })

  it('rejects before the write when not connected', async () => {
    const { client } = setup()
    await expect(client.request('turn/start', {})).rejects.toMatchObject({
      code: 'executor.rejected',
    })
  })

  it('turns an error response into rejected with the rpc code', async () => {
    const { client, sockets } = setup()
    await client.connect()
    const pending = client.request('turn/start', {})
    await tick()
    sockets[0].push({ id: sockets[0].requests()[0].id, error: { code: -32601, message: 'nope' } })
    await expect(pending).rejects.toMatchObject({ code: 'executor.rejected', rpcCode: -32601 })
  })

  it('turns a drop after the write into send_uncertain', async () => {
    const { client, sockets } = setup({ refuse: index => index > 0 })
    await client.connect()
    const pending = client.request('turn/start', {})
    await tick()
    sockets[0].drop()
    await expect(pending).rejects.toMatchObject({ code: 'executor.send_uncertain' })
  })

  it('turns a response timeout after the write into send_uncertain', async () => {
    const { client } = setup({ requestTimeoutMs: 20 })
    await client.connect()
    await expect(client.request('turn/start', {})).rejects.toMatchObject({
      code: 'executor.send_uncertain',
    })
  })

  it('refuses config write methods and anything outside the allow list before the socket', async () => {
    const { client, sockets } = setup()
    await client.connect()
    for (const method of [
      'config/value/write',
      'config/batchWrite',
      'skills/config/write',
      'fs/readFile',
    ]) {
      await expect(client.request(method, {})).rejects.toMatchObject({ code: 'executor.rejected' })
    }
    expect(sockets[0].requests()).toEqual([])
    const allowed = client.request('hooks/list', {})
    await tick()
    sockets[0].reply(sockets[0].requests()[0].id as number, { data: [] })
    await expect(allowed).resolves.toEqual({ data: [] })
  })

  it('reconnects with the same token and reinitializes', async () => {
    const { client, sockets, states } = setup()
    await client.connect()
    sockets[0].drop()
    await tick(40)
    expect(sockets).toHaveLength(2)
    expect(sockets[1].headers).toEqual(sockets[0].headers)
    expect(sockets[1].frames.map(frame => frame.method)).toEqual(['initialize', 'initialized'])
    expect(states).toEqual(['connected', 'reconnecting', 'connected'])
  })

  it('gives up after 3 failed reconnections', async () => {
    const { client, sockets, states } = setup({ refuse: index => index > 0 })
    await client.connect()
    sockets[0].drop()
    await tick(80)
    expect(sockets).toHaveLength(4)
    expect(states).toEqual(['connected', 'reconnecting', 'closed'])
    await expect(client.request('turn/start', {})).rejects.toMatchObject({
      code: 'executor.rejected',
    })
  })

  it('does not reconnect after close()', async () => {
    const { client, sockets } = setup()
    await client.connect()
    await client.close()
    await tick(30)
    expect(sockets).toHaveLength(1)
  })
})

describe('CodexJsonRpcClient ping and request ids (F2-11)', () => {
  it('resolves ping on pong and rejects with executor.unavailable without pong', async () => {
    const { client, sockets } = setup()
    await client.connect()
    await expect(client.ping(60_000)).resolves.toBeUndefined()
    sockets[0].pongOnPing = false
    await expect(client.ping(20)).rejects.toMatchObject({ code: 'executor.unavailable' })
    expect(sockets[0].pings).toBe(2)
  })

  it('rejects ping when not connected', async () => {
    const { client } = setup()
    await expect(client.ping(20)).rejects.toMatchObject({ code: 'executor.unavailable' })
  })

  it('hands the JSON-RPC request id to the server request handler', async () => {
    const { client, sockets } = setup()
    await client.connect()
    const seen: unknown[] = []
    client.onServerRequest('item/fileChange/requestApproval', async (_params, requestId) => {
      seen.push(requestId)
      return { decision: 'accept' }
    })
    sockets[0].push({ id: 'srv-9', method: 'item/fileChange/requestApproval', params: {} })
    await tick()
    expect(seen).toEqual(['srv-9'])
  })

  it('reports a server request without handler to the unhandled listener, still answering -32601', async () => {
    const { client, sockets } = setup()
    await client.connect()
    const unhandled: string[] = []
    client.onUnhandledServerRequest(method => unhandled.push(method))
    sockets[0].push({ id: 7, method: 'weird/method', params: {} })
    await tick()
    expect(unhandled).toEqual(['weird/method'])
    expect(sockets[0].frames.at(-1)).toMatchObject({ id: 7, error: { code: -32601 } })
  })
})
