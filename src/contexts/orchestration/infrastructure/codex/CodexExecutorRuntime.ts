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
import type { HookKeyHash } from '../../application/ports/repositories'
import {
  createExecutorProcessSupervisor,
  type ExecutorProcessSupervisor,
  type ServiceExit,
  type StartQueue,
  type SupervisedService,
} from '../process/ExecutorProcessSupervisor'
import type { CodexAppServerProcess, CodexAppServerStartInput } from './CodexAppServerProcess'
import { runtimeError, startPingLoop, type CodexJsonRpcClient } from './CodexJsonRpcClient'
import { findPendingHooks, hookOverridesFromApproved } from './CodexHookTrust'
import {
  APPROVAL_METHODS,
  dispatchIdOfTurn,
  lastAgentMessage,
  mapCompletionOutcome,
  snapshotOfTurn,
  PendingApprovals,
} from './codexEventMapping'
import { codexReadSchemas, type CodexReadDefinition } from './protocol/codexProtocol'

export const TURNS_PAGE_SIZE = 20
const READ_TURN_MAX_PAGES = 5
const REMOTE_TOKEN_ENV = 'OPENCOVE_EXECUTOR_REMOTE_TOKEN'
const ARCHIVE_REASONS: ReadonlySet<ExecutorCloseReason> = new Set([
  'user',
  'link_closed',
  'node_deleted',
])

export type CodexRpcClient = Pick<
  CodexJsonRpcClient,
  | 'connect'
  | 'request'
  | 'ping'
  | 'close'
  | 'onNotification'
  | 'onServerRequest'
  | 'onUnhandledServerRequest'
  | 'onStateChange'
>

export interface CodexRuntimeCollaborators {
  startProcess: (input: CodexAppServerStartInput) => Promise<CodexAppServerProcess>
  createClient: (target: { url: string; token: string }) => CodexRpcClient
  /** Pairs (key, hash) the Glimpse approved; read at each service start. */
  approvedHooks: () => Promise<readonly HookKeyHash[]>
  startQueue?: StartQueue
}

export interface CodexRuntimeConfig {
  readonly spec: ExecutorStartSpec
  readonly executablePath: string
  readonly version: string
  /** Full environment of the child, already filtered. */
  readonly env: Record<string, string>
  readonly sandbox: 'workspace-write' | 'danger-full-access'
  readonly approvalPolicy: 'on-request' | 'never'
}

interface CodexService extends SupervisedService {
  readonly process: CodexAppServerProcess
  readonly client: CodexRpcClient
  stopPing: () => void
}

function parseRead<K extends CodexReadDefinition>(
  name: K,
  value: unknown,
): ReturnType<(typeof codexReadSchemas)[K]['parse']> {
  const result = codexReadSchemas[name].safeParse(value)
  if (!result.success) {
    throw runtimeError('executor.protocol_mismatch', `unexpected ${name}`)
  }
  return result.data as never
}

export class CodexExecutorRuntime implements ExecutorRuntime {
  private readonly listeners = new Set<ExecutorRuntimeListener>()
  private readonly supervisor: ExecutorProcessSupervisor<CodexService>
  private readonly activeTurns = new Set<string>()
  private readonly turnDispatch = new Map<string, string | null>()
  private readonly lastMessages = new Map<string, string>()
  private readonly approvals = new PendingApprovals()
  private current: CodexService | null = null
  private sessionRef: string | null = null
  private inFlightDispatchId: string | null = null
  private closing = false

  constructor(
    private readonly deps: CodexRuntimeCollaborators,
    private readonly config: CodexRuntimeConfig,
  ) {
    this.supervisor = createExecutorProcessSupervisor<CodexService>({
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
    const resumed = input.resumeRef !== null && !input.fresh
    const sessionRef = resumed
      ? await this.resumeThread(input.resumeRef as string)
      : await this.startThread()
    this.sessionRef = sessionRef
    await this.reportPendingHooks()
    return { sessionRef, resumed }
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.inFlightDispatchId = input.dispatchId
    try {
      const response = await this.rpc().request('turn/start', {
        threadId: this.requireSession(),
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        clientUserMessageId: input.dispatchId,
      })
      const { turn } = parseRead('TurnStartResponse', response)
      this.turnDispatch.set(turn.id, input.dispatchId)
      return { turnRef: turn.id }
    } finally {
      this.inFlightDispatchId = null
    }
  }

  async findTurnByDispatch(dispatchId: string, since: Date): Promise<FindTurnResult> {
    try {
      const page = await this.listTurns(null)
      const match = page.data.find(turn => dispatchIdOfTurn(turn) === dispatchId)
      if (match) {
        return { kind: 'found', turn: snapshotOfTurn(match) }
      }
      const oldest = page.data.at(-1)?.startedAt
      const readableSince =
        !page.nextCursor || (typeof oldest === 'number' && oldest * 1000 < since.getTime())
      return readableSince ? { kind: 'absent' } : { kind: 'unknown' }
    } catch {
      return { kind: 'unknown' }
    }
  }

  async readTurn(turnRef: string): Promise<ExecutorTurnSnapshot> {
    let cursor: string | null = null
    for (let index = 0; index < READ_TURN_MAX_PAGES; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- pages are read in order.
      const page = await this.listTurns(cursor)
      const match = page.data.find(turn => turn.id === turnRef)
      if (match) {
        return snapshotOfTurn(match)
      }
      if (!page.nextCursor) {
        break
      }
      cursor = page.nextCursor
    }
    throw runtimeError('executor.rejected', `turn not found: ${turnRef}`)
  }

  async respondApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<RespondApprovalResult> {
    const reply = this.approvals.respond(requestId, decision)
    if (reply.outcome === 'missing') {
      return { ok: false, reason: 'approval_not_found' }
    }
    if (reply.outcome === 'answered') {
      this.emit({ type: 'approval.resolved', requestId, resolvedBy: 'glimpse' })
      if (decision === 'cancel') {
        await this.interrupt(reply.turnRef ?? undefined)
      }
    }
    return { ok: true }
  }

  async interrupt(turnRef?: string): Promise<void> {
    const turns = turnRef === undefined ? [...this.activeTurns] : [turnRef]
    const threadId = this.sessionRef
    if (threadId === null) {
      return
    }
    for (const turnId of turns) {
      // eslint-disable-next-line no-await-in-loop -- one interrupt at a time.
      await this.rpc().request('turn/interrupt', { threadId, turnId })
    }
  }

  async attachInfo(): Promise<ExecutorAttachInfo> {
    if (!this.current || this.sessionRef === null) {
      throw runtimeError('executor.unavailable', 'service is not running')
    }
    return {
      url: this.current.process.url,
      tokenEnv: { name: REMOTE_TOKEN_ENV, value: this.current.process.token },
      sessionRef: this.sessionRef,
      cwd: this.config.spec.cwd,
    }
  }

  async close(reason: ExecutorCloseReason): Promise<void> {
    this.closing = true
    if (this.current && this.sessionRef !== null) {
      await this.interrupt().catch(() => undefined)
      if (ARCHIVE_REASONS.has(reason)) {
        await this.current.client
          .request('thread/archive', { threadId: this.sessionRef })
          .catch(() => undefined)
      }
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

  private rpc(): CodexRpcClient {
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

  private async launch(): Promise<CodexService> {
    const { spec, executablePath, env } = this.config
    const hookTrust = hookOverridesFromApproved(await this.deps.approvedHooks())
    const process = await this.deps.startProcess({ executablePath, cwd: spec.cwd, env, hookTrust })
    const client = this.deps.createClient({ url: process.url, token: process.token })
    try {
      await client.connect()
    } catch (error) {
      await process.close()
      throw error
    }
    this.wire(client, process)
    const stopPing = startPingLoop(client, {
      onDegraded: () => this.emit({ type: 'executor.degraded', reason: 'ping_failed' }),
      onRecovered: () => this.emitReady(),
    })
    const service: CodexService = {
      process,
      client,
      stopPing,
      exited: process.exited,
      close: async () => {
        stopPing()
        await client.close()
        await process.close()
      },
    }
    this.current = service
    return service
  }

  private wire(client: CodexRpcClient, process: CodexAppServerProcess): void {
    client.onNotification((method, params) => this.handleNotification(method, params))
    for (const method of APPROVAL_METHODS) {
      client.onServerRequest(method, (params, requestId) =>
        this.approvals.hold(method, params, requestId, event => this.emit(event)),
      )
    }
    client.onUnhandledServerRequest(method =>
      this.emit({ type: 'executor.degraded', reason: `unsupported_request:${method}` }),
    )
    client.onStateChange(state => {
      if (state === 'closed' && !this.closing) {
        void process.close()
      }
    })
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
    this.current?.stopPing()
    this.current = null
    this.activeTurns.clear()
    this.approvals.clear()
    this.inFlightDispatchId = null
    this.emit({
      type: 'executor.down',
      reason: 'process_exit',
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
    })
  }

  /** The order is `executor.ready` then `executor.recovered`; the health fold accepts both. */
  private async handleRecovered(): Promise<void> {
    const sessionRef = this.sessionRef
    const service = this.current
    if (sessionRef === null || !service) {
      return
    }
    try {
      await this.resumeThread(sessionRef)
    } catch {
      await service.process.close()
      return
    }
    this.emitReady()
    this.emit({ type: 'executor.recovered', sessionRef })
  }

  private threadPolicy() {
    const { sandbox, approvalPolicy, spec } = this.config
    return { cwd: spec.cwd, sandbox, approvalPolicy }
  }

  private async startThread(): Promise<string> {
    const { spec } = this.config
    const response = await this.rpc().request('thread/start', {
      ...this.threadPolicy(),
      ephemeral: false,
      serviceName: 'glimpse',
      ...(spec.model === null ? {} : { model: spec.model }),
    })
    const threadId = parseRead('ThreadStartResponse', response).thread.id
    await this.rpc()
      .request('thread/name/set', { threadId, name: `Glimpse: ${spec.executorNodeId}` })
      .catch(() => undefined)
    return threadId
  }

  private async resumeThread(threadId: string): Promise<string> {
    try {
      const response = await this.rpc().request('thread/resume', {
        threadId,
        ...this.threadPolicy(),
      })
      return parseRead('ThreadResumeResponse', response).thread.id
    } catch (error) {
      if ((error as { code?: string }).code === 'executor.rejected') {
        throw runtimeError('executor.session_lost', (error as Error).message)
      }
      throw error
    }
  }

  private async reportPendingHooks(): Promise<void> {
    try {
      const response = await this.rpc().request('hooks/list', { cwds: [this.config.spec.cwd] })
      const hooks = parseRead('HooksListResponse', response).data.flatMap(entry => entry.hooks)
      const pending = findPendingHooks(hooks, await this.deps.approvedHooks())
      if (pending.length > 0) {
        this.emit({ type: 'hooks.trust_pending', hooks: pending })
      }
    } catch {
      // Listing hooks is informative; a failure never blocks the session.
    }
  }

  private async listTurns(cursor: string | null) {
    const response = await this.rpc().request('thread/turns/list', {
      threadId: this.requireSession(),
      limit: TURNS_PAGE_SIZE,
      sortDirection: 'desc',
      ...(cursor === null ? {} : { cursor }),
    })
    return parseRead('ThreadTurnsListResponse', response)
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'turn/started') {
      this.onTurnStarted(params)
    } else if (method === 'item/completed') {
      this.onItemCompleted(params)
    } else if (method === 'turn/completed') {
      this.onTurnCompleted(params)
    } else if (method === 'serverRequest/resolved') {
      this.onServerRequestResolved(params)
    }
  }

  private onTurnStarted(params: unknown): void {
    const parsed = codexReadSchemas.TurnStartedNotification.safeParse(params)
    if (!parsed.success || parsed.data.threadId !== this.sessionRef) {
      return
    }
    const { turn } = parsed.data
    const hasUser = (turn.items ?? []).some(item => item.type === 'userMessage')
    const dispatchId =
      dispatchIdOfTurn(turn) ??
      this.turnDispatch.get(turn.id) ??
      (hasUser ? null : this.inFlightDispatchId)
    this.turnDispatch.set(turn.id, dispatchId)
    this.activeTurns.add(turn.id)
    this.emit({
      type: 'turn.started',
      turnRef: turn.id,
      dispatchId,
      origin: dispatchId === null ? 'screen' : 'glimpse',
    })
  }

  private onItemCompleted(params: unknown): void {
    const parsed = codexReadSchemas.ItemCompletedNotification.safeParse(params)
    if (parsed.success && parsed.data.threadId === this.sessionRef) {
      const { item, turnId } = parsed.data
      if (item.type === 'agentMessage' && item.text !== undefined) {
        this.lastMessages.set(turnId, item.text)
      }
    }
  }

  private onTurnCompleted(params: unknown): void {
    const parsed = codexReadSchemas.TurnCompletedNotification.safeParse(params)
    if (!parsed.success || parsed.data.threadId !== this.sessionRef) {
      return
    }
    const { turn } = parsed.data
    const dispatchId = this.turnDispatch.get(turn.id) ?? dispatchIdOfTurn(turn)
    const finalMessage = this.lastMessages.get(turn.id) ?? lastAgentMessage(turn)
    this.activeTurns.delete(turn.id)
    this.turnDispatch.delete(turn.id)
    this.lastMessages.delete(turn.id)
    this.emit({
      type: 'turn.completed',
      turnRef: turn.id,
      dispatchId,
      outcome: mapCompletionOutcome(turn.status),
      finalMessage,
      usage: null,
    })
  }

  private onServerRequestResolved(params: unknown): void {
    const parsed = codexReadSchemas.ServerRequestResolvedNotification.safeParse(params)
    if (!parsed.success) {
      return
    }
    const requestId = String(parsed.data.requestId)
    if (this.approvals.closeFromScreen(requestId)) {
      this.emit({ type: 'approval.resolved', requestId, resolvedBy: 'screen' })
    }
  }
}
