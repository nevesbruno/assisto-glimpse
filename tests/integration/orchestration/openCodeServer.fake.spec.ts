/* eslint-disable no-await-in-loop -- the request body and the fake streams are sequential. */
// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  probeOpenCodeInfo,
  startOpenCodeServeProcess,
  type OpenCodeServeChild,
  type OpenCodeServeDeps,
} from '../../../src/contexts/orchestration/infrastructure/opencode/OpenCodeServeProcess'
import { OpenCodeHttpClient } from '../../../src/contexts/orchestration/infrastructure/opencode/OpenCodeHttpClient'
import { createOpenCodeExecutorRuntimeFactory } from '../../../src/contexts/orchestration/infrastructure/opencode/OpenCodeExecutorRuntimeFactory'
import { openCodeMessageIdForDispatch } from '../../../src/contexts/orchestration/infrastructure/opencode/openCodeEventMapping'
import type { ExecutorRuntimeEvent } from '../../../src/contexts/orchestration/application/ports/executorRuntime'

const PASSWORD = 'integration-password'
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`, 'utf8').toString('base64')}`

interface StoredMessage {
  id: string
  type: 'user' | 'assistant' | 'idle'
  time: { created: number }
  text?: string
  content?: { type: 'text'; text: string }[]
  tokens?: { input: number; output: number }
  outcome?: string
}

interface Recorded {
  method: string
  path: string
  body: unknown
  authorization: string | undefined
}

/** The v2 contract of `opencode serve` at the shape the adapter reads, over real HTTP and SSE. */
class FakeOpenCodeServer {
  readonly requests: Recorded[] = []
  readonly messages: StoredMessage[] = []
  readonly permissions = new Map<string, Record<string, unknown>>()
  readonly decisions: string[] = []
  readonly interrupts: string[] = []
  infoFailuresLeft = 0
  infoHtml = false
  private readonly server: Server
  private readonly streams = new Set<ServerResponse>()
  private clock = 1000
  private sessions = new Set<string>()

  constructor(private readonly port: number) {
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(this.port, '127.0.0.1', resolve))
  }

  async close(): Promise<void> {
    for (const stream of this.streams) {
      stream.end()
    }
    this.streams.clear()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  countsOf(path: string): number {
    return this.requests.filter(entry => entry.path === path).length
  }

  userMessagesOf(id: string): number {
    return this.messages.filter(message => message.type === 'user' && message.id === id).length
  }

  push(event: Record<string, unknown>): void {
    this.writeFrame(JSON.stringify(event))
  }

  dropStreams(): void {
    for (const stream of this.streams) {
      stream.end()
    }
    this.streams.clear()
  }

  addAssistantTurn(text: string): void {
    this.messages.push({
      id: `msg_${(this.clock += 1)}`,
      type: 'assistant',
      time: { created: this.clock },
      content: [{ type: 'text', text }],
      tokens: { input: 5, output: 2 },
    })
    this.messages.push({
      id: `msg_${(this.clock += 1)}`,
      type: 'idle',
      time: { created: this.clock },
      outcome: 'succeeded',
    })
  }

  private writeFrame(data: string): void {
    for (const stream of this.streams) {
      stream.write(`data: ${data}\n\n`)
    }
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? null : JSON.parse(text)
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`)
    const path = url.pathname
    const body = await this.readBody(request).catch(() => null)
    this.requests.push({
      method: request.method ?? 'GET',
      path: `${path}${url.search}`,
      body,
      authorization: request.headers.authorization,
    })
    if (request.headers.authorization !== AUTH) {
      this.json(response, 401, { _tag: 'UnauthorizedError' })
      return
    }
    if (path === '/api/info') {
      if (this.infoFailuresLeft > 0) {
        this.infoFailuresLeft -= 1
        this.json(response, 503, { _tag: 'Unavailable' })
        return
      }
      if (this.infoHtml) {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html><body>not the api</body></html>')
        return
      }
      this.json(response, 200, { version: '2.3.0', capabilities: { persistentPty: true } })
      return
    }
    if (path === '/api/event') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.write('data: {"id":"e0","type":"server.connected","data":{}}\n\n')
      this.streams.add(response)
      request.on('close', () => this.streams.delete(response))
      return
    }
    if (path === '/api/session' && request.method === 'POST') {
      const id = 'ses_fake'
      this.sessions.add(id)
      this.json(response, 200, { data: { id, time: { created: 0 }, title: body } })
      return
    }
    const sessionMatch = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path)
    if (sessionMatch) {
      const sessionId = sessionMatch[1]
      const rest = sessionMatch[2] ?? ''
      if (!this.sessions.has(sessionId) && rest !== '') {
        this.json(response, 404, { _tag: 'SessionNotFoundError', sessionID: sessionId })
        return
      }
      if (rest === '' && request.method === 'GET') {
        this.json(response, 200, { data: { id: sessionId, time: { created: 0 } } })
        return
      }
      if (rest === '/prompt' && request.method === 'POST') {
        const prompt = body as { id: string; text: string }
        if (!this.messages.some(message => message.id === prompt.id)) {
          this.messages.push({
            id: prompt.id,
            type: 'user',
            time: { created: (this.clock += 1) },
            text: prompt.text,
          })
        }
        this.json(response, 200, { data: { id: prompt.id } })
        return
      }
      if (rest.startsWith('/message/') && request.method === 'GET') {
        const id = rest.slice('/message/'.length)
        const message = this.messages.find(candidate => candidate.id === id)
        if (!message) {
          this.json(response, 404, { _tag: 'MessageNotFoundError' })
          return
        }
        this.json(response, 200, { data: message })
        return
      }
      if (rest === '/message' && request.method === 'GET') {
        const ordered = [...this.messages].sort((a, b) => b.time.created - a.time.created)
        this.json(response, 200, { data: ordered })
        return
      }
      if (rest === '/permission' && request.method === 'GET') {
        this.json(response, 200, { data: [...this.permissions.values()] })
        return
      }
      const reply = /^\/permission\/([^/]+)\/reply$/.exec(rest)
      if (reply && request.method === 'POST') {
        const decision = (body as { decision: string }).decision
        this.decisions.push(decision)
        this.permissions.delete(reply[1])
        this.push({
          id: `evt-${this.clock++}`,
          type: 'permission.replied',
          data: { sessionID: sessionId, requestID: reply[1], reply: decision },
        })
        response.writeHead(204)
        response.end()
        return
      }
      if (rest === '/interrupt' && request.method === 'POST') {
        this.interrupts.push(sessionId)
        this.json(response, 200, { interrupted: true })
        return
      }
    }
    this.json(response, 404, { _tag: 'NotFound' })
  }
}

class FakeChild extends EventEmitter {
  stderr = null
  constructor(readonly pid: number) {
    super()
  }
}

const openServers: FakeOpenCodeServer[] = []
const openChildren: FakeChild[] = []
let nextPort = 45100

async function serveProcessHarness(options: { infoFailures?: number; html?: boolean }) {
  const port = ++nextPort
  const server = new FakeOpenCodeServer(port)
  server.infoFailuresLeft = options.infoFailures ?? 0
  server.infoHtml = options.html ?? false
  await server.listen()
  openServers.push(server)
  const kills: [number, string][] = []
  const deps: Partial<OpenCodeServeDeps> = {
    portReserver: { reserveLoopbackPort: async () => port },
    spawnChild: () => {
      const child = new FakeChild(9000 + openChildren.length)
      openChildren.push(child)
      return child as unknown as OpenCodeServeChild
    },
    probeInfo: (candidatePort, password) => probeOpenCodeInfo(candidatePort, password),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    randomToken: () => PASSWORD,
    killGroup: (pid, signal) => {
      kills.push([pid, signal])
      openChildren.find(child => child.pid === pid)?.emit('exit', null, signal)
    },
  }
  return { server, port, deps, kills }
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close()
  }
  openChildren.length = 0
})

describe('opencode serve over real HTTP and SSE (F3-01)', () => {
  it('survives two 503 on /api/info and starts on the same attempt', async () => {
    const { server, port, deps, kills } = await serveProcessHarness({ infoFailures: 2 })
    const handle = await startOpenCodeServeProcess(
      { executablePath: '/bin/opencode', cwd: '/w', env: { PATH: '/bin' } },
      deps.portReserver!,
      deps,
    )
    expect(handle.port).toBe(port)
    expect(server.countsOf('/api/info')).toBe(3)
    expect(kills).toEqual([])
    await handle.close()
  })

  it('fails with executor.protocol_mismatch on HTML and ends the process', async () => {
    const { deps, kills } = await serveProcessHarness({ html: true })
    await expect(
      startOpenCodeServeProcess(
        { executablePath: '/bin/opencode', cwd: '/w', env: { PATH: '/bin' } },
        deps.portReserver!,
        deps,
      ),
    ).rejects.toMatchObject({ code: 'executor.protocol_mismatch' })
    expect(kills).toEqual([[9000, 'SIGTERM']])
  })

  it('proves the whole adapter against the fake service: turn, dedupe, approval, reconnect', async () => {
    const { server, deps } = await serveProcessHarness({ infoFailures: 0 })
    const processes = await startOpenCodeServeProcess(
      { executablePath: '/bin/opencode', cwd: '/w', env: { PATH: '/bin' } },
      deps.portReserver!,
      deps,
    )
    const factory = createOpenCodeExecutorRuntimeFactory({
      resolveExecutable: async () => ({ executablePath: '/bin/opencode', version: '2.3.0' }),
      startProcess: async () => processes,
      createClient: ({ url, password }) =>
        new OpenCodeHttpClient({ url, password, reconnectDelayMs: () => 20 }),
      baseEnv: { PATH: '/bin' },
    })
    const runtime = await factory.start({
      executorNodeId: 'node-1',
      title: 'Agente C',
      provider: 'opencode',
      cwd: '/w',
      env: {},
      sessionRef: null,
      model: null,
      policy: { approvals: 'user', sandbox: null },
    })
    const events: ExecutorRuntimeEvent[] = []
    runtime.subscribe(event => events.push(event))
    await expect(runtime.ensureSession({ resumeRef: null, fresh: false })).resolves.toEqual({
      sessionRef: 'ses_fake',
      resumed: false,
    })

    const dispatchId = '7f3a2c1e-5b4d-4e6f-8a9b-0c1d2e3f4a5b'
    const messageId = openCodeMessageIdForDispatch(dispatchId)
    const first = await runtime.startTurn({ dispatchId, text: 'faça o teste' })
    const second = await runtime.startTurn({ dispatchId, text: 'faça o teste' })
    expect(first.turnRef).toBe(messageId)
    expect(second.turnRef).toBe(messageId)
    expect(server.countsOf('/api/session/ses_fake/prompt')).toBe(2)
    expect(server.userMessagesOf(messageId)).toBe(1)

    await expect(runtime.findTurnByDispatch(dispatchId, new Date(0))).resolves.toMatchObject({
      kind: 'found',
      turn: { turnRef: messageId, status: 'running' },
    })
    server.push({
      id: 'evt-started',
      type: 'session.execution.started',
      data: { sessionID: 'ses_fake' },
    })
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'turn.started',
        turnRef: messageId,
        dispatchId,
        origin: 'glimpse',
      }),
    )
    server.permissions.set('perm-1', {
      id: 'perm-1',
      sessionID: 'ses_fake',
      action: 'bash',
      resources: ['ls'],
      message: 'rodar ls',
    })
    server.push({
      id: 'evt-perm',
      type: 'permission.asked',
      data: {
        id: 'perm-1',
        sessionID: 'ses_fake',
        action: 'bash',
        resources: ['ls'],
        message: 'rodar ls',
      },
    })
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'approval.requested',
        requestId: 'perm-1',
        kind: 'bash',
        summary: 'rodar ls',
        turnRef: messageId,
      }),
    )
    await expect(runtime.respondApproval('perm-1', 'approve')).resolves.toEqual({ ok: true })
    expect(server.decisions).toEqual(['once'])

    server.addAssistantTurn('feito')
    server.push({
      id: 'evt-done',
      type: 'session.execution.succeeded',
      data: { sessionID: 'ses_fake' },
    })
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'turn.completed',
        turnRef: messageId,
        dispatchId,
        outcome: 'completed',
        finalMessage: 'feito',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    )

    server.permissions.set('perm-2', {
      id: 'perm-2',
      sessionID: 'ses_fake',
      action: 'write',
      resources: ['/tmp/x'],
    })
    server.dropStreams()
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'executor.degraded', reason: 'sse_disconnected' }),
    )
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'approval.requested', requestId: 'perm-2' }),
      ),
    )
    await expect(runtime.interrupt()).resolves.toBeUndefined()
    expect(server.interrupts).toEqual(['ses_fake'])
    await runtime.close('user')
  })
})
