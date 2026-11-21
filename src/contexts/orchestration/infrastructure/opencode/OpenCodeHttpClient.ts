/* eslint-disable no-await-in-loop -- the stream and the reconnect attempts are sequential. */
import type {
  ExecutorRuntimeError,
  ExecutorRuntimeErrorCode,
  Unsubscribe,
} from '../../application/ports/executorRuntime'

export const OPEN_CODE_RECONNECT_DELAYS_MS: readonly number[] = [1000, 2000, 4000]
export const OPEN_CODE_REQUEST_TIMEOUT_MS = 30_000

export function runtimeError(
  code: ExecutorRuntimeErrorCode,
  message: string,
): ExecutorRuntimeError {
  return Object.assign(new Error(message), { code })
}

export type OpenCodeClientState = 'idle' | 'connected' | 'reconnecting' | 'closed'
export type OpenCodeEvent = Record<string, unknown>
export type OpenCodeEventListener = (event: OpenCodeEvent) => void
export type OpenCodeStateListener = (state: OpenCodeClientState, reason?: string) => void

export interface OpenCodeHttpResult {
  readonly status: number
  readonly body: unknown
}

export interface OpenCodeHttpClientOptions {
  readonly url: string
  readonly password: string
  readonly requestTimeoutMs?: number
  /** Attempt number, 1-based; the default is 1 s, 2 s and 4 s. */
  readonly reconnectDelayMs?: (attempt: number) => number
  readonly maxReconnects?: number
  readonly fetchImpl?: typeof globalThis.fetch
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isAbort = (error: unknown): boolean =>
  isRecord(error) && (error['name'] === 'AbortError' || error['name'] === 'TimeoutError')

/**
 * HTTP and SSE of `opencode serve`. The send boundary of a write is the request dispatch: a status
 * answer is `executor.rejected` for the caller, a lost answer is `executor.send_uncertain`.
 */
export class OpenCodeHttpClient {
  private readonly url: string
  private readonly password: string
  private readonly requestTimeoutMs: number
  private readonly reconnectDelayMs: (attempt: number) => number
  private readonly maxReconnects: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly eventListeners = new Set<OpenCodeEventListener>()
  private readonly stateListeners = new Set<OpenCodeStateListener>()
  private abort: AbortController | null = null
  private state: OpenCodeClientState = 'idle'
  private closing = false
  private reconnecting = false
  private reconnectQueued = false

  constructor(options: OpenCodeHttpClientOptions) {
    this.url = options.url.replace(/\/$/, '')
    this.password = options.password
    this.requestTimeoutMs = options.requestTimeoutMs ?? OPEN_CODE_REQUEST_TIMEOUT_MS
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? (attempt => OPEN_CODE_RECONNECT_DELAYS_MS[attempt - 1] ?? 4000)
    this.maxReconnects = options.maxReconnects ?? OPEN_CODE_RECONNECT_DELAYS_MS.length
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  get currentState(): OpenCodeClientState {
    return this.state
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`opencode:${this.password}`, 'utf8').toString('base64')}`,
      ...extra,
    }
  }

  async get(path: string): Promise<OpenCodeHttpResult> {
    return this.request('GET', path, undefined, 'executor.unavailable')
  }

  async post(path: string, body: unknown): Promise<OpenCodeHttpResult> {
    return this.request('POST', path, body, 'executor.send_uncertain')
  }

  onEvent(listener: OpenCodeEventListener): Unsubscribe {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: OpenCodeStateListener): Unsubscribe {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Opens the event stream and resolves once the response headers were accepted. */
  async connect(): Promise<void> {
    const controller = new AbortController()
    this.abort = controller
    const response = await this.fetchImpl(`${this.url}/api/event`, {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal: controller.signal,
    }).catch(error => {
      throw runtimeError(
        'executor.start_failed',
        `event stream did not open: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (!response.ok || response.body === null) {
      throw runtimeError('executor.start_failed', `event stream refused: ${response.status}`)
    }
    this.setState('connected')
    void this.consume(response.body, controller)
  }

  close(): void {
    this.closing = true
    this.abort?.abort()
    this.abort = null
    this.setState('closed')
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    lostAnswerCode: ExecutorRuntimeErrorCode,
  ): Promise<OpenCodeHttpResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const response = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const text = await response.text().catch(() => '')
      let parsed: unknown = null
      if (text !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = null
        }
      }
      return { status: response.status, body: parsed }
    } catch (error) {
      if (method === 'POST') {
        throw runtimeError(
          lostAnswerCode,
          `no answer to ${path}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      throw runtimeError(
        'executor.unavailable',
        isAbort(error)
          ? `timeout on ${path}`
          : `request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private setState(state: OpenCodeClientState, reason?: string): void {
    this.state = state
    this.stateListeners.forEach(listener => listener(state, reason))
  }

  private emitEvent(event: OpenCodeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        // A failing listener never stops the stream.
      }
    }
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    controller: AbortController,
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          this.dispatchFrame(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // The stream ended or was aborted; the reconnect decision is below.
    } finally {
      reader.releaseLock()
    }
    if (controller.signal.aborted || this.closing) {
      return
    }
    void this.reconnect()
  }

  private dispatchFrame(frame: string): void {
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) {
        data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
      }
    }
    if (data.length === 0) {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n'))
    } catch {
      return
    }
    if (isRecord(parsed) && typeof parsed['type'] === 'string') {
      this.emitEvent(parsed)
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) {
      this.reconnectQueued = true
      return
    }
    this.reconnecting = true
    this.setState('reconnecting')
    try {
      for (let attempt = 1; attempt <= this.maxReconnects && !this.closing; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- attempts are sequential by design.
        await new Promise(resolve => setTimeout(resolve, this.reconnectDelayMs(attempt)))
        if (this.closing) {
          return
        }
        try {
          // eslint-disable-next-line no-await-in-loop -- attempts are sequential by design.
          await this.connect()
          return
        } catch {
          // Next attempt.
        }
      }
      if (!this.closing) {
        this.setState('closed', 'reconnect_exhausted')
      }
    } finally {
      this.reconnecting = false
      if (this.reconnectQueued && !this.closing) {
        this.reconnectQueued = false
        void this.reconnect()
      }
    }
  }
}
