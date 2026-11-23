/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type {
  ExecutorRuntime,
  ExecutorRuntimeEvent,
  ExecutorStartSpec,
} from '../../../../../src/contexts/orchestration/application/ports/executorRuntime'
import type { OpenCodeHttpResult } from '../../../../../src/contexts/orchestration/infrastructure/opencode/OpenCodeHttpClient'
import { createOpenCodeExecutorRuntimeFactory } from '../../../../../src/contexts/orchestration/infrastructure/opencode/OpenCodeExecutorRuntimeFactory'
import {
  openCodeMessageIdForDispatch,
  type OpenCodeMessage,
} from '../../../../../src/contexts/orchestration/infrastructure/opencode/openCodeEventMapping'

export const PASSWORD = 'harness-password'
export const SESSION = 'ses_1'
export const PASSWORD_SHA = createHash('sha256').update(PASSWORD).digest('hex')

export type Reply = { status: number; body?: unknown } | Error

const ok = (body: unknown): Reply => ({ status: 200, body })
const noContent = (): Reply => ({ status: 204 })

export const userMessage = (id: string, created: number, text = 'hi'): OpenCodeMessage => ({
  id,
  type: 'user',
  text,
  time: { created },
})
export const assistantMessage = (
  id: string,
  created: number,
  text: string,
  tokens?: { input: number; output: number },
): OpenCodeMessage => ({
  id,
  type: 'assistant',
  time: { created },
  content: [{ type: 'text', text }],
  ...(tokens ? { tokens } : {}),
})
export const idleMessage = (
  id: string,
  created: number,
  outcome = 'succeeded',
): OpenCodeMessage => ({
  id,
  type: 'idle',
  outcome,
  time: { created },
})

class FakeClient {
  readonly requests: { method: 'GET' | 'POST'; path: string; body: unknown }[] = []
  readonly eventListeners = new Set<(event: Record<string, unknown>) => void>()
  readonly stateListeners = new Set<(state: string, reason?: string) => void>()
  replies: ((method: 'GET' | 'POST', path: string, body: unknown) => Reply | undefined)[] = []
  closed = false

  constructor(readonly log: string[]) {}

  connect = vi.fn(async () => {
    this.log.push('sse:connect')
  })
  close = vi.fn(async () => {
    this.closed = true
    this.log.push('sse:close')
  })

  get(path: string): Promise<OpenCodeHttpResult> {
    return this.send('GET', path, undefined)
  }

  post(path: string, body: unknown): Promise<OpenCodeHttpResult> {
    return this.send('POST', path, body)
  }

  onEvent(listener: (event: Record<string, unknown>) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: (state: string, reason?: string) => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  emit(event: Record<string, unknown>): void {
    this.eventListeners.forEach(listener => listener(event))
  }

  setState(state: string, reason?: string): void {
    if (this.closed) {
      return
    }
    this.stateListeners.forEach(listener => listener(state, reason))
  }

  /** The process died: the real client retries 1, 2 and 4 s, then closes the stream. */
  streamFailed(): void {
    if (this.closed) {
      return
    }
    this.setState('reconnecting')
    setTimeout(() => this.setState('closed', 'reconnect_exhausted'), 7000)
  }

  paths(method?: 'GET' | 'POST'): string[] {
    return this.requests
      .filter(entry => !method || entry.method === method)
      .map(entry => entry.path)
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
  ): Promise<OpenCodeHttpResult> {
    this.requests.push({ method, path, body })
    this.log.push(`${method.toLowerCase()}:${path}`)
    for (const reply of this.replies) {
      const value = reply(method, path, body)
      if (value !== undefined) {
        if (value instanceof Error) {
          throw value
        }
        return { status: value.status, body: value.body ?? null }
      }
    }
    return this.defaultReply(method, path, body)
  }

  private defaultReply(method: 'GET' | 'POST', path: string, body: unknown): OpenCodeHttpResult {
    if (method === 'POST' && path === '/api/session') {
      return { status: 200, body: { data: { id: SESSION, time: { created: 0 } } } }
    }
    if (method === 'GET' && path === `/api/session/${SESSION}`) {
      return { status: 200, body: { data: { id: SESSION, time: { created: 0 } } } }
    }
    if (method === 'POST' && path === `/api/session/${SESSION}/prompt`) {
      return { status: 200, body: { data: { id: (body as { id: string }).id } } }
    }
    if (method === 'GET' && path.startsWith(`/api/session/${SESSION}/message?`)) {
      return { status: 200, body: { data: [] } }
    }
    if (method === 'GET' && path.startsWith(`/api/session/${SESSION}/message/`)) {
      return { status: 404, body: { _tag: 'MessageNotFoundError' } }
    }
    if (method === 'GET' && path === `/api/session/${SESSION}/permission`) {
      return { status: 200, body: { data: [] } }
    }
    if (method === 'POST' && path.includes('/permission/') && path.endsWith('/reply')) {
      return { status: 204, body: null }
    }
    if (method === 'POST' && path === `/api/session/${SESSION}/interrupt`) {
      return { status: 200, body: { interrupted: true } }
    }
    return { status: 404, body: { _tag: 'NotFound' } }
  }
}

export function setup(
  options: { pid?: number; version?: string; uuidV5?: (name: string) => string } = {},
) {
  const log: string[] = []
  const clients: FakeClient[] = []
  const processes: {
    exit: (code: number | null, signal: string | null) => void
    close: ReturnType<typeof vi.fn>
  }[] = []
  const startInputs: { env: Record<string, string>; cwd: string }[] = []
  const factory = createOpenCodeExecutorRuntimeFactory({
    resolveExecutable: async () => ({
      executablePath: '/bin/opencode',
      version: options.version ?? '2.3.0',
    }),
    startProcess: async input => {
      startInputs.push({ env: input.env, cwd: input.cwd })
      let resolveExit!: (value: { code: number | null; signal: string | null }) => void
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        resolveExit = resolve
      })
      const close = vi.fn(async () => {
        log.push('sigterm')
      })
      const index = processes.length
      processes.push({
        exit: (code, signal) => {
          clients[index]?.streamFailed()
          resolveExit({ code, signal })
        },
        close,
      })
      return {
        pid: options.pid ?? 8123,
        port: 4400 + processes.length,
        url: `http://127.0.0.1:${4400 + processes.length}`,
        password: PASSWORD,
        passwordSha256: PASSWORD_SHA,
        exited,
        close,
      }
    },
    createClient: () => {
      const client = new FakeClient(log)
      clients.push(client)
      return client as never
    },
    baseEnv: { PATH: '/bin', OPENCOVE_CONTROL_TOKEN: 'secret', HOME: '/home/u' },
    ...(options.uuidV5 ? { uuidV5: options.uuidV5 } : {}),
  })
  const spec: ExecutorStartSpec = {
    executorNodeId: 'node-1',
    title: 'Agente B',
    provider: 'opencode',
    cwd: '/w',
    env: { ANTHROPIC_API_KEY: 'k' },
    sessionRef: null,
    model: null,
    policy: { approvals: 'user', sandbox: null },
  }
  const events: ExecutorRuntimeEvent[] = []
  const start = async (): Promise<ExecutorRuntime> => {
    const runtime = await factory.start(spec)
    runtime.subscribe(event => events.push(event))
    return runtime
  }
  return {
    factory,
    start,
    clients,
    processes,
    events,
    log,
    startInputs,
    client: () => clients.at(-1)!,
    idFor: (dispatchId: string) => openCodeMessageIdForDispatch(dispatchId, options.uuidV5),
  }
}

export async function ready(options?: Parameters<typeof setup>[0]) {
  const env = setup(options)
  const runtime = await env.start()
  await runtime.ensureSession({ resumeRef: null, fresh: false })
  return { ...env, runtime }
}

export { ok, noContent }

export type { FakeClient }
