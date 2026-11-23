import type {
  ApprovalDecision,
  EnsureSessionInput,
  EnsureSessionResult,
  ExecutorAttachInfo,
  ExecutorCloseReason,
  ExecutorRuntime,
  ExecutorRuntimeEvent,
  ExecutorRuntimeListener,
  ExecutorStartSpec,
  ExecutorTurnSnapshot,
  FindTurnResult,
  RespondApprovalResult,
  StartTurnInput,
  StartTurnResult,
  Unsubscribe,
} from '../../application/ports/executorRuntime'
import {
  createExecutorProcessSupervisor,
  type ExecutorProcessSupervisor,
  type ServiceExit,
  type StartQueue,
  type SupervisedService,
} from '../process/ExecutorProcessSupervisor'
import { runtimeError, type OpenCodeHttpClient } from './OpenCodeHttpClient'
import type { OpenCodeServeProcess, OpenCodeServeStartInput } from './OpenCodeServeProcess'
import { OPEN_CODE_SERVER_PASSWORD_ENV } from './openCodeProcessEnv'
import {
  executionOutcomeOf,
  isKnownEventType,
  isMessage,
  messagesOf,
  OpenCodeApprovals,
  OpenCodeTurns,
  openCodeDecisionOf,
  openCodeMessageIdForDispatch,
  permissionRequestsOf,
  replyBodyOf,
  sessionCreatedAtOf,
  sessionIdOf,
  snapshotOfTurn,
  type OpenCodeMessage,
  uuidV5,
} from './openCodeEventMapping'

export const OPEN_CODE_MESSAGES_PAGE_SIZE = 20

export type OpenCodeClient = Pick<
  OpenCodeHttpClient,
  'get' | 'post' | 'connect' | 'close' | 'onEvent' | 'onStateChange'
>

export interface OpenCodeRuntimeCollaborators {
  startProcess: (input: OpenCodeServeStartInput) => Promise<OpenCodeServeProcess>
  createClient: (target: { url: string; password: string }) => OpenCodeClient
  startQueue?: StartQueue
  uuidV5?: (name: string) => string
}

export interface OpenCodeRuntimeConfig {
  readonly spec: ExecutorStartSpec
  readonly executablePath: string
  readonly version: string
  /** Full environment of the child, without the password and without `OPENCOVE_*`. */
  readonly env: Record<string, string>
}

interface OpenCodeService extends SupervisedService {
  readonly process: OpenCodeServeProcess
  readonly client: OpenCodeClient
}

/**
 * One `opencode serve` per link: session reused by the link, turns over HTTP and events over SSE,
 * with the same supervisor and event vocabulary as the Codex adapter.
 */
export class OpenCodeExecutorRuntime implements ExecutorRuntime {
  private readonly listeners = new Set<ExecutorRuntimeListener>()
  private readonly supervisor: ExecutorProcessSupervisor<OpenCodeService>
  private readonly approvals: OpenCodeApprovals
  private readonly turns: OpenCodeTurns
  private readonly degradedTypes = new Set<string>()
  private current: OpenCodeService | null = null
  private sessionRef: string | null = null
  private closing = false
  private wasDisconnected = false

  constructor(
    private readonly deps: OpenCodeRuntimeCollaborators,
    private readonly config: OpenCodeRuntimeConfig,
  ) {
    this.approvals = new OpenCodeApprovals(event => this.emit(event))
    this.turns = new OpenCodeTurns({
      emit: event => this.emit(event),
      sessionRef: () => this.sessionRef,
      readMessages: () => this.messagesWindow(),
      messageIdOf: dispatchId => this.messageIdOf(dispatchId),
    })
    this.supervisor = createExecutorProcessSupervisor<OpenCodeService>({
      launch: () => this.launch(),
      startQueue: deps.startQueue,
      listener: {
        onDown: exit => this.handleDown(exit),
        onRecovered: () => void this.handleRecovered(),
        onUnavailable: () =>
          this.emit({
            type: 'executor.down',
            reason: 'restarts_exhausted',
            exitCode: null,
            signal: null,
          }),
      },
    })
  }

  async start(): Promise<void> {
    await this.supervisor.start()
  }

  subscribe(listener: ExecutorRuntimeListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    if (input.resumeRef !== null && !input.fresh) {
      const existing = await this.client().get(`/api/session/${input.resumeRef}`)
      if (existing.status === 200) {
        const data = replyBodyOf(existing.body)
        const sessionRef = typeof data['id'] === 'string' ? data['id'] : input.resumeRef
        this.adoptSession(sessionRef)
        return { sessionRef, resumed: true }
      }
      if (existing.status !== 404) {
        throw runtimeError('executor.session_lost', `session ${input.resumeRef} is not readable`)
      }
      const created = await this.createSession()
      return { sessionRef: created, resumed: false }
    }
    const created = await this.createSession()
    return { sessionRef: created, resumed: false }
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.turns.beginDispatch(input.dispatchId)
    try {
      const messageId = this.messageIdOf(input.dispatchId)
      const response = await this.client().post(`/api/session/${this.requireSession()}/prompt`, {
        id: messageId,
        text: input.text,
      })
      if (response.status >= 400) {
        throw runtimeError('executor.rejected', `prompt refused with ${response.status}`)
      }
      const data = replyBodyOf(response.body)
      const turnRef = typeof data['id'] === 'string' ? data['id'] : messageId
      this.turns.accept(turnRef, input.dispatchId)
      return { turnRef }
    } finally {
      this.turns.endDispatch()
    }
  }

  async findTurnByDispatch(dispatchId: string, since: Date): Promise<FindTurnResult> {
    try {
      const turnRef = this.messageIdOf(dispatchId)
      const message = await this.client().get(
        `/api/session/${this.requireSession()}/message/${turnRef}`,
      )
      if (message.status === 200) {
        return { kind: 'found', turn: await this.snapshotOf(turnRef, message.body) }
      }
      if (message.status !== 404) {
        return { kind: 'unknown' }
      }
      const session = await this.client().get(`/api/session/${this.requireSession()}`)
      if (session.status !== 200) {
        return { kind: 'unknown' }
      }
      const createdAt = sessionCreatedAtOf(session.body)
      if (createdAt === null) {
        return { kind: 'unknown' }
      }
      return createdAt <= since.getTime() ? { kind: 'absent' } : { kind: 'unknown' }
    } catch {
      return { kind: 'unknown' }
    }
  }

  async readTurn(turnRef: string): Promise<ExecutorTurnSnapshot> {
    const message = await this.client().get(
      `/api/session/${this.requireSession()}/message/${turnRef}`,
    )
    if (message.status === 404) {
      throw runtimeError('executor.rejected', `turn not found: ${turnRef}`)
    }
    if (message.status !== 200) {
      throw runtimeError('executor.rejected', `turn is not readable: ${turnRef}`)
    }
    return this.snapshotOf(turnRef, message.body)
  }

  async respondApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<RespondApprovalResult> {
    const previous = this.approvals.outcomeOf(requestId)
    if (previous !== null) {
      return previous === 'answered' ? { ok: true } : { ok: false, reason: 'approval_not_found' }
    }
    const sessionRef = this.sessionRef
    if (sessionRef === null) {
      return { ok: false, reason: 'approval_not_found' }
    }
    const response = await this.client().post(
      `/api/session/${sessionRef}/permission/${requestId}/reply`,
      { decision: openCodeDecisionOf(decision) },
    )
    if (response.status === 404) {
      return { ok: false, reason: 'approval_not_found' }
    }
    if (response.status >= 400) {
      throw runtimeError('executor.rejected', `permission reply refused with ${response.status}`)
    }
    this.approvals.markAnswered(requestId)
    if (decision === 'cancel') {
      await this.interrupt().catch(() => undefined)
    }
    return { ok: true }
  }

  async interrupt(_turnRef?: string): Promise<void> {
    const sessionRef = this.sessionRef
    if (sessionRef === null) {
      return
    }
    const response = await this.client().post(`/api/session/${sessionRef}/interrupt`, {})
    if (response.status === 404) {
      return
    }
    if (response.status >= 400) {
      throw runtimeError('executor.rejected', `interrupt refused with ${response.status}`)
    }
  }

  async attachInfo(): Promise<ExecutorAttachInfo> {
    if (!this.current || this.sessionRef === null) {
      throw runtimeError('executor.unavailable', 'service is not running')
    }
    return {
      url: this.current.process.url,
      tokenEnv: { name: OPEN_CODE_SERVER_PASSWORD_ENV, value: this.current.process.password },
      sessionRef: this.sessionRef,
      cwd: this.config.spec.cwd,
    }
  }

  serviceIdentity = async () => {
    const process = this.current?.process
    return process && process.pid > 1
      ? { pid: process.pid, tokenSha256: process.passwordSha256 }
      : null
  }

  async close(_reason: ExecutorCloseReason): Promise<void> {
    this.closing = true
    if (this.current && this.sessionRef !== null) {
      await this.interrupt().catch(() => undefined)
    }
    await this.supervisor.stop()
  }

  private emit(event: ExecutorRuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A failing listener never stops the others.
      }
    }
  }

  private client(): OpenCodeClient {
    if (!this.current) {
      throw runtimeError('executor.unavailable', 'service is not running')
    }
    return this.current.client
  }

  private requireSession(): string {
    if (this.sessionRef === null) {
      throw runtimeError('executor.rejected', 'no session')
    }
    return this.sessionRef
  }

  private messageIdOf(dispatchId: string): string {
    const v5 = this.deps.uuidV5 ?? ((name: string) => uuidV5(name))
    return openCodeMessageIdForDispatch(dispatchId, v5)
  }

  private adoptSession(sessionRef: string): void {
    this.sessionRef = sessionRef
  }

  private async createSession(): Promise<string> {
    const { spec } = this.config
    const response = await this.client().post(`/api/session`, {
      title: `Glimpse: ${spec.title?.trim() || spec.executorNodeId}`,
      location: { directory: spec.cwd },
      ...(spec.model === null ? {} : { model: spec.model }),
    })
    const data = replyBodyOf(response.body)
    if (response.status >= 400 || typeof data['id'] !== 'string') {
      throw runtimeError('executor.session_lost', `session creation failed with ${response.status}`)
    }
    this.adoptSession(data['id'])
    return data['id']
  }

  private async messagesWindow(): Promise<readonly OpenCodeMessage[]> {
    const response = await this.client().get(
      `/api/session/${this.requireSession()}/message?order=desc&limit=${OPEN_CODE_MESSAGES_PAGE_SIZE}`,
    )
    return messagesOf(response.body)
  }

  private async snapshotOf(turnRef: string, body: unknown): Promise<ExecutorTurnSnapshot> {
    const data = replyBodyOf(body)
    if (!isMessage(data)) {
      throw runtimeError('executor.protocol_mismatch', 'message is not readable')
    }
    const messages = await this.messagesWindow().catch(() => [] as readonly OpenCodeMessage[])
    return snapshotOfTurn(turnRef, data, messages)
  }

  private async launch(): Promise<OpenCodeService> {
    const { executablePath, env, spec } = this.config
    const process = await this.deps.startProcess({ executablePath, cwd: spec.cwd, env })
    const client = this.deps.createClient({ url: process.url, password: process.password })
    try {
      await client.connect()
    } catch (error) {
      await process.close()
      throw error
    }
    const service: OpenCodeService = {
      process,
      client,
      exited: process.exited,
      close: async () => {
        await client.close()
        await process.close()
      },
    }
    this.current = service
    this.wire(client)
    return service
  }

  /** Only the active client drives the health: a dead or replaced one must not degrade the new. */
  private wire(client: OpenCodeClient): void {
    const isActive = (): boolean => this.current?.client === client
    client.onEvent(event => {
      if (isActive()) {
        this.handleEvent(event)
      }
    })
    client.onStateChange(state => {
      if (isActive()) {
        this.handleState(state)
      }
    })
  }

  private handleState(state: string): void {
    if (state === 'reconnecting') {
      this.wasDisconnected = true
      this.emit({ type: 'executor.degraded', reason: 'sse_disconnected' })
      return
    }
    if (state === 'connected' && this.wasDisconnected) {
      this.wasDisconnected = false
      void this.rebuildAfterReconnect()
      return
    }
    if (state === 'closed' && !this.closing) {
      this.emit({ type: 'executor.degraded', reason: 'sse_closed' })
    }
  }

  /** The stream lost events while it was down: permissions are the only state it can rebuild. */
  private async rebuildAfterReconnect(): Promise<void> {
    const sessionRef = this.sessionRef
    if (sessionRef === null) {
      return
    }
    try {
      const response = await this.client().get(`/api/session/${sessionRef}/permission`)
      for (const entry of permissionRequestsOf(response.body)) {
        this.approvals.announce(entry, this.turns.lastTurnRef)
      }
    } catch {
      // A failed read leaves the stream degraded; the next reconnect tries again.
    }
    this.emitReady()
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = typeof event['type'] === 'string' ? event['type'] : null
    if (type === null) {
      return
    }
    const data = typeof event['data'] === 'object' && event['data'] !== null ? event['data'] : {}
    if (type === 'server.connected') {
      return
    }
    if (type === 'session.execution.started') {
      this.turns.onExecutionStarted(data as Record<string, unknown>)
      return
    }
    const outcome = executionOutcomeOf(type)
    if (outcome !== null) {
      void this.turns.onExecutionEnded(data as Record<string, unknown>, outcome)
      return
    }
    if (type === 'permission.asked') {
      this.approvals.announce(data as Record<string, unknown>, this.turns.lastTurnRef)
      return
    }
    if (type === 'permission.replied') {
      this.onPermissionReplied(data as Record<string, unknown>)
      return
    }
    if (!isKnownEventType(type) && !this.degradedTypes.has(type)) {
      this.degradedTypes.add(type)
      this.emit({ type: 'executor.degraded', reason: `unknown_event:${type}` })
    }
  }

  private onPermissionReplied(data: Record<string, unknown>): void {
    if (sessionIdOf(data) !== this.sessionRef) {
      return
    }
    const requestId = data['requestID']
    if (typeof requestId === 'string') {
      this.approvals.onReplied(requestId)
    }
  }

  private emitReady(): void {
    if (this.sessionRef !== null) {
      this.emit({
        type: 'executor.ready',
        sessionRef: this.sessionRef,
        resumed: true,
        version: this.config.version,
      })
    }
  }

  private handleDown(exit: ServiceExit | null): void {
    // The SSE of the dead service retries 1, 2 and 4 s before giving up; left open, its final
    // `closed` would arrive after the restart and turn the recovered executor degraded again.
    const dead = this.current
    this.current = null
    dead?.client.close()
    this.approvals.clear()
    this.turns.forget()
    this.emit({
      type: 'executor.down',
      reason: 'process_exit',
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
    })
  }

  private async handleRecovered(): Promise<void> {
    const sessionRef = this.sessionRef
    const service = this.current
    if (sessionRef === null || !service) {
      return
    }
    try {
      const response = await service.client.get(`/api/session/${sessionRef}`)
      if (response.status === 404) {
        await this.createSession()
      } else if (response.status !== 200) {
        await service.process.close()
        return
      }
    } catch {
      await service.process.close()
      return
    }
    this.emitReady()
    this.emit({ type: 'executor.recovered', sessionRef: this.sessionRef as string })
  }
}
