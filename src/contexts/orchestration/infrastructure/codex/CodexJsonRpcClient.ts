/* eslint-disable no-await-in-loop -- reconnection attempts are sequential by design. */
import WebSocket from 'ws'
import type {
  ExecutorRuntimeError,
  ExecutorRuntimeErrorCode,
  Unsubscribe,
} from '../../application/ports/executorRuntime'

export const METHOD_NOT_FOUND = -32601
export const INTERNAL_ERROR = -32603

const BLOCKED_METHODS: ReadonlySet<string> = new Set([
  'config/value/write',
  'config/batchWrite',
  'skills/config/write',
])
const ALLOWED_METHOD = /^(thread\/|turn\/)|^hooks\/list$/

export type RpcSocket = WebSocket
export type CreateSocket = (url: string, headers: Record<string, string>) => RpcSocket

export type CodexClientState = 'idle' | 'connected' | 'reconnecting' | 'closed'
export type RpcNotificationListener = (method: string, params: unknown) => void
export type RpcServerRequestHandler = (
  params: unknown,
  requestId: string | number,
) => Promise<unknown>
export type RpcUnhandledRequestListener = (method: string) => void
export type RpcStateListener = (state: CodexClientState, reason?: string) => void

export interface CodexJsonRpcClientOptions {
  readonly url: string
  readonly token: string
  readonly clientVersion?: string
  readonly requestTimeoutMs?: number
  readonly maxReconnects?: number
  readonly reconnectDelayMs?: (attempt: number) => number
  readonly createSocket?: CreateSocket
}

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
}

export function runtimeError(
  code: ExecutorRuntimeErrorCode,
  message: string,
  rpcCode?: number,
): ExecutorRuntimeError & { readonly rpcCode?: number } {
  return Object.assign(new Error(message), { code, rpcCode })
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

const defaultCreateSocket: CreateSocket = (url, headers) =>
  new WebSocket(url, { headers, handshakeTimeout: 5000 })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** JSON-RPC over ws to `codex app-server`. The send boundary is the write of the frame. */
export class CodexJsonRpcClient {
  private socket: RpcSocket | null = null
  private state: CodexClientState = 'idle'
  private nextId = 0
  private closing = false
  private handshaking = false
  private readonly pending = new Map<number, Pending>()
  private readonly notificationListeners = new Set<RpcNotificationListener>()
  private readonly stateListeners = new Set<RpcStateListener>()
  private readonly serverHandlers = new Map<string, RpcServerRequestHandler>()
  private readonly unhandledListeners = new Set<RpcUnhandledRequestListener>()
  private readonly createSocket: CreateSocket
  private readonly requestTimeoutMs: number
  private readonly maxReconnects: number
  private readonly reconnectDelayMs: (attempt: number) => number

  constructor(private readonly options: CodexJsonRpcClientOptions) {
    this.createSocket = options.createSocket ?? defaultCreateSocket
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.maxReconnects = options.maxReconnects ?? 3
    this.reconnectDelayMs = options.reconnectDelayMs ?? (attempt => 250 * 2 ** (attempt - 1))
  }

  /** Opens the socket, then `initialize` and `initialized`. Resolves the `userAgent`. */
  async connect(): Promise<string> {
    const userAgent = await this.establish()
    this.setState('connected')
    return userAgent
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (BLOCKED_METHODS.has(method) || !ALLOWED_METHOD.test(method)) {
      throw runtimeError('executor.rejected', `method not allowed for the client: ${method}`)
    }
    return this.send(method, params)
  }

  onNotification(listener: RpcNotificationListener): Unsubscribe {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onStateChange(listener: RpcStateListener): Unsubscribe {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Requests from the server for a method without handler are answered with -32601. */
  onServerRequest(method: string, handler: RpcServerRequestHandler): void {
    this.serverHandlers.set(method, handler)
  }

  /** Called for each server request with no handler, which is answered with -32601. */
  onUnhandledServerRequest(listener: RpcUnhandledRequestListener): Unsubscribe {
    this.unhandledListeners.add(listener)
    return () => this.unhandledListeners.delete(listener)
  }

  /** Websocket ping; rejects with `executor.unavailable` without a pong inside `timeoutMs`. */
  ping(timeoutMs: number): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(runtimeError('executor.unavailable', 'not connected'))
    }
    return new Promise<void>((resolve, reject) => {
      const onPong = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        socket.off('pong', onPong)
        reject(runtimeError('executor.unavailable', 'ping timeout'))
      }, timeoutMs)
      socket.once('pong', onPong)
      socket.ping(undefined, undefined, error => {
        if (error) {
          clearTimeout(timer)
          socket.off('pong', onPong)
          reject(runtimeError('executor.unavailable', `ping failed: ${error.message}`))
        }
      })
    })
  }

  async close(): Promise<void> {
    this.closing = true
    this.rejectAllPending()
    const socket = this.socket
    this.socket = null
    this.setState('closed')
    socket?.close()
  }

  private async establish(): Promise<string> {
    const socket = await this.openSocket()
    this.socket = socket
    this.handshaking = true
    try {
      const result = await this.send('initialize', {
        clientInfo: {
          name: 'glimpse-orchestration',
          title: null,
          version: this.options.clientVersion ?? '0',
        },
        capabilities: null,
      })
      await this.writeFrame(socket, { method: 'initialized' })
      return isRecord(result) && typeof result.userAgent === 'string' ? result.userAgent : ''
    } catch (error) {
      this.socket = null
      socket.close()
      throw error
    } finally {
      this.handshaking = false
    }
  }

  private openSocket(): Promise<RpcSocket> {
    return new Promise<RpcSocket>((resolve, reject) => {
      const socket = this.createSocket(this.options.url, {
        Authorization: `Bearer ${this.options.token}`,
      })
      let opened = false
      socket.once('open', () => {
        opened = true
        resolve(socket)
      })
      socket.on('message', data => this.handleMessage(socket, data.toString()))
      socket.on('error', error => {
        if (!opened) {
          reject(runtimeError('executor.start_failed', `connection failed: ${error.message}`))
        }
      })
      socket.on('close', () => {
        if (!opened) {
          reject(runtimeError('executor.start_failed', 'connection closed before open'))
          return
        }
        this.handleClose(socket)
      })
    })
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(runtimeError('executor.rejected', 'not connected'))
    }
    const id = ++this.nextId
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { resolve, reject, timer: null }
      this.pending.set(id, entry)
      this.writeFrame(socket, { id, method, ...(params === undefined ? {} : { params }) }).then(
        () => {
          if (this.pending.get(id) === entry) {
            entry.timer = setTimeout(() => {
              this.pending.delete(id)
              reject(runtimeError('executor.send_uncertain', `no response to ${method}`))
            }, this.requestTimeoutMs)
          }
        },
        (error: Error) => {
          if (this.pending.delete(id)) {
            reject(error)
          }
        },
      )
    })
  }

  /** Rejects with `executor.rejected` when the frame was not written, `send_uncertain` when unsure. */
  private writeFrame(socket: RpcSocket, frame: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let text: string
      try {
        text = JSON.stringify(frame)
      } catch (error) {
        reject(runtimeError('executor.rejected', `unserializable request: ${String(error)}`))
        return
      }
      try {
        socket.send(text, error => {
          if (!error) {
            resolve()
          } else if (socket.readyState === WebSocket.OPEN) {
            reject(runtimeError('executor.rejected', `write failed: ${error.message}`))
          } else {
            reject(runtimeError('executor.send_uncertain', `write interrupted: ${error.message}`))
          }
        })
      } catch (error) {
        reject(runtimeError('executor.rejected', `write failed: ${String(error)}`))
      }
    })
  }

  private handleMessage(socket: RpcSocket, text: string): void {
    if (socket !== this.socket) {
      return
    }
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(message)) {
      return
    }
    const { id, method } = message
    const hasId = typeof id === 'number' || typeof id === 'string'
    if (typeof method === 'string' && hasId) {
      void this.answerServerRequest(socket, id, method, message.params)
    } else if (typeof method === 'string') {
      this.notificationListeners.forEach(listener => listener(method, message.params))
    } else if (typeof id === 'number') {
      this.settle(id, message)
    }
  }

  private settle(id: number, message: Record<string, unknown>): void {
    const entry = this.pending.get(id)
    if (!entry) {
      return
    }
    this.pending.delete(id)
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : undefined
      const detail = typeof message.error.message === 'string' ? message.error.message : 'error'
      entry.reject(runtimeError('executor.rejected', detail, code))
    } else {
      entry.resolve(message.result)
    }
  }

  private async answerServerRequest(
    socket: RpcSocket,
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.serverHandlers.get(method)
    let frame: Record<string, unknown>
    if (!handler) {
      this.unhandledListeners.forEach(listener => listener(method))
      frame = { id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } }
    } else {
      try {
        frame = { id, result: await handler(params, id) }
      } catch (error) {
        frame = { id, error: { code: INTERNAL_ERROR, message: String(error) } }
      }
    }
    await this.writeFrame(socket, frame).catch(() => undefined)
  }

  private handleClose(socket: RpcSocket): void {
    if (socket !== this.socket) {
      return
    }
    this.socket = null
    this.rejectAllPending()
    if (!this.closing && !this.handshaking) {
      void this.reconnect()
    }
  }

  private rejectAllPending(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.reject(runtimeError('executor.send_uncertain', 'connection lost before the response'))
    }
    this.pending.clear()
  }

  private async reconnect(): Promise<void> {
    this.setState('reconnecting')
    let reason = 'connection lost'
    for (let attempt = 1; attempt <= this.maxReconnects && !this.closing; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, this.reconnectDelayMs(attempt)))
      if (this.closing) {
        return
      }
      try {
        await this.establish()
        this.setState('connected')
        return
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error)
      }
    }
    if (!this.closing) {
      this.setState('closed', reason)
    }
  }

  private setState(state: CodexClientState, reason?: string): void {
    this.state = state
    this.stateListeners.forEach(listener => listener(state, reason))
  }

  get currentState(): CodexClientState {
    return this.state
  }
}

export const PING_INTERVAL_MS = 15_000
export const PING_TIMEOUT_MS = 5000
export const PING_FAILURES_TO_DEGRADE = 2

export interface PingLoopHandlers {
  onDegraded: () => void
  onRecovered: () => void
}

/** Pings every 15 s; two failures in a row degrade once, the next pong recovers. Returns the stop. */
export function startPingLoop(
  client: Pick<CodexJsonRpcClient, 'ping'>,
  handlers: PingLoopHandlers,
): () => void {
  let failures = 0
  let degraded = false
  let inFlight = false
  const timer = setInterval(() => {
    if (inFlight) {
      return
    }
    inFlight = true
    client
      .ping(PING_TIMEOUT_MS)
      .then(() => {
        failures = 0
        if (degraded) {
          degraded = false
          handlers.onRecovered()
        }
      })
      .catch(() => {
        failures += 1
        if (failures >= PING_FAILURES_TO_DEGRADE && !degraded) {
          degraded = true
          handlers.onDegraded()
        }
      })
      .finally(() => {
        inFlight = false
      })
  }, PING_INTERVAL_MS)
  return () => clearInterval(timer)
}
