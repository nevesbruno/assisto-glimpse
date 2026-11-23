/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type {
  ExecutorRuntime,
  ExecutorRuntimeEvent,
  ExecutorStartSpec,
} from '../../../../../src/contexts/orchestration/application/ports/executorRuntime'
import { createCodexExecutorRuntimeFactory } from '../../../../../src/contexts/orchestration/infrastructure/codex/CodexExecutorRuntimeFactory'

type Handler = (params: unknown, id: string | number) => Promise<unknown>
export const BLOCKED = ['config/value/write', 'config/batchWrite', 'skills/config/write']
export const APPROVAL = 'item/commandExecution/requestApproval'

export const turn = (id: string, status: string, items: unknown[] = []) => ({ id, status, items })
export const userMessage = (clientId: string | null) => ({ type: 'userMessage', id: 'u', clientId })
export const agentMessage = (text: string) => ({ type: 'agentMessage', id: `a-${text}`, text })

class FakeClient {
  readonly requests: { method: string; params: unknown }[] = []
  readonly handlers = new Map<string, Handler>()
  readonly notifyListeners = new Set<(method: string, params: unknown) => void>()
  readonly unhandled = new Set<(method: string) => void>()
  readonly stateListeners = new Set<(state: string, reason?: string) => void>()
  pingFails = false
  responses: Record<string, (params: unknown) => unknown> = {
    'thread/start': () => ({ thread: { id: 'thr-1' } }),
    'thread/resume': () => ({ thread: { id: 'thr-1' } }),
    'thread/name/set': () => ({}),
    'hooks/list': () => ({ data: [{ cwd: '/w', hooks: [] }] }),
    'turn/start': () => ({ turn: turn('turn-1', 'inProgress') }),
    'turn/interrupt': () => ({}),
    'thread/archive': () => ({}),
    'thread/turns/list': () => ({ data: [], nextCursor: null }),
  }

  constructor(readonly log: string[]) {}

  connect = vi.fn(async () => 'codex-cli 0.167.0')
  close = vi.fn(async () => undefined)
  ping = vi.fn(async () => {
    if (this.pingFails) {
      throw new Error('no pong')
    }
  })

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    this.log.push(`req:${method}`)
    const respond = this.responses[method]
    if (!respond) {
      throw new Error(`unexpected ${method}`)
    }
    return respond(params)
  }

  onNotification(listener: (method: string, params: unknown) => void) {
    this.notifyListeners.add(listener)
    return () => this.notifyListeners.delete(listener)
  }

  onServerRequest(method: string, handler: Handler): void {
    this.handlers.set(method, handler)
  }

  onUnhandledServerRequest(listener: (method: string) => void) {
    this.unhandled.add(listener)
    return () => this.unhandled.delete(listener)
  }

  onStateChange(listener: (state: string, reason?: string) => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  notify(method: string, params: unknown): void {
    this.notifyListeners.forEach(listener => listener(method, params))
  }

  methods(): string[] {
    return this.requests.map(entry => entry.method)
  }

  serverRequest(method: string, params: unknown, id: string | number): Promise<unknown> | null {
    const handler = this.handlers.get(method)
    if (!handler) {
      this.unhandled.forEach(listener => listener(method))
      return null
    }
    return handler(params, id)
  }
}

export function setup(
  options: {
    fullAccess?: () => boolean
    approved?: { key: string; currentHash: string }[]
    pid?: number
  } = {},
) {
  const log: string[] = []
  const clients: FakeClient[] = []
  const processes: {
    exit: (code: number | null, signal: string | null) => void
    close: ReturnType<typeof vi.fn>
  }[] = []
  const startInputs: { hookTrust: unknown; env: unknown }[] = []
  const factory = createCodexExecutorRuntimeFactory({
    resolveExecutable: async () => ({ executablePath: '/bin/codex', version: '0.167.0' }),
    startProcess: async input => {
      startInputs.push({ hookTrust: input.hookTrust, env: input.env })
      let resolveExit!: (value: { code: number | null; signal: string | null }) => void
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        resolveExit = resolve
      })
      const close = vi.fn(async () => {
        log.push('sigterm')
      })
      processes.push({ exit: (code, signal) => resolveExit({ code, signal }), close })
      return {
        pid: options.pid ?? 4242,
        port: 5,
        url: 'ws://127.0.0.1:5',
        token: 'tok',
        tokenSha256: createHash('sha256').update('tok').digest('hex'),
        exited,
        close,
      }
    },
    createClient: () => {
      const client = new FakeClient(log)
      clients.push(client)
      return client as never
    },
    approvedHooks: async () => options.approved ?? [],
    readFullAccess: options.fullAccess ?? (() => false),
    baseEnv: { PATH: '/bin', OPENCOVE_CONTROL_TOKEN: 'secret' },
  })
  const spec: ExecutorStartSpec = {
    executorNodeId: 'node-1',
    title: 'Agente A',
    provider: 'codex',
    cwd: '/w',
    env: { OPENAI_API_KEY: 'k' },
    sessionRef: null,
    model: null,
    policy: { approvals: 'user', sandbox: 'ignored-by-adapter' },
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
  }
}

export async function ready(options?: Parameters<typeof setup>[0]) {
  const env = setup(options)
  const runtime = await env.start()
  await runtime.ensureSession({ resumeRef: null, fresh: false })
  return { ...env, runtime }
}

export const flush = () => vi.advanceTimersByTimeAsync(0)
