import { createHash } from 'node:crypto'
import type {
  ApprovalDecision,
  ExecutorRuntimeEvent,
  ExecutorTurnSnapshot,
  ExecutorTurnStatus,
  ExecutorTurnUsage,
  TurnCompletionOutcome,
} from '../../application/ports/executorRuntime'

export const OPEN_CODE_MESSAGE_PREFIX = 'msg_'
/** The same DNS namespace the Worker id generator uses, so both sides agree on the message id. */
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function namespaceBytes(namespace: string): Buffer {
  return Buffer.from(namespace.replaceAll('-', ''), 'hex')
}

/** RFC 4122 v5 over SHA-1; the project has no dependency for it and must not add one. */
export function uuidV5(name: string, namespace: string = DNS_NAMESPACE): string {
  const bytes = createHash('sha1')
    .update(namespaceBytes(namespace))
    .update(name)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The server dedupes the prompt by this id: the same dispatch always lands on the same message. */
export function openCodeMessageIdForDispatch(
  dispatchId: string,
  v5: (name: string) => string = name => uuidV5(name),
): string {
  return `${OPEN_CODE_MESSAGE_PREFIX}${v5(`opencode:${dispatchId}`).replaceAll('-', '')}`
}

export interface OpenCodeMessage {
  readonly id: string
  readonly type: string
  readonly time?: { readonly created?: number }
  readonly text?: string
  readonly outcome?: string
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  readonly tokens?: { readonly input?: number; readonly output?: number }
}

export function isMessage(value: unknown): value is OpenCodeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as OpenCodeMessage).id === 'string' &&
    typeof (value as OpenCodeMessage).type === 'string'
  )
}

export function messagesOf(body: unknown): readonly OpenCodeMessage[] {
  if (typeof body !== 'object' || body === null) {
    return []
  }
  const data = (body as { data?: unknown }).data
  return Array.isArray(data) ? data.filter(isMessage) : []
}

const createdOf = (message: OpenCodeMessage): number => message.time?.created ?? 0

/** Text of the last assistant message that landed after the user message of the turn. */
export function assistantTextOf(messages: readonly OpenCodeMessage[]): string | null {
  const assistants = messages.filter(message => message.type === 'assistant')
  const last = assistants.at(-1)
  if (!last) {
    return null
  }
  const parts = (last.content ?? []).filter(part => part.type === 'text' && part.text)
  return parts.map(part => part.text).join('') || null
}

export function usageOf(messages: readonly OpenCodeMessage[]): ExecutorTurnUsage | null {
  const last = messages.filter(message => message.type === 'assistant').at(-1)
  if (!last?.tokens) {
    return null
  }
  return { inputTokens: last.tokens.input ?? null, outputTokens: last.tokens.output ?? null }
}

export function mapIdleOutcome(outcome: string | undefined): TurnCompletionOutcome {
  return outcome === 'failed' || outcome === 'interrupted' ? outcome : 'completed'
}

export function mapTurnStatus(outcome: string | undefined): ExecutorTurnStatus {
  return outcome === undefined ? 'running' : mapIdleOutcome(outcome)
}

/**
 * The turn is the user message; its end is the newest `idle` message created after it. Messages of
 * later turns also satisfy that rule, which is why callers pass the newest page only.
 */
export function snapshotOfTurn(
  turnRef: string,
  user: OpenCodeMessage,
  messages: readonly OpenCodeMessage[],
): ExecutorTurnSnapshot {
  const after = messages
    .filter(message => message.id !== user.id && createdOf(message) > createdOf(user))
    .sort((a, b) => createdOf(a) - createdOf(b))
  const idle = after.filter(message => message.type === 'idle').at(-1)
  return {
    turnRef,
    status: mapTurnStatus(idle?.outcome),
    finalMessage: assistantTextOf(after),
    usage: usageOf(after),
  }
}

/** Event types this adapter reads. Everything else is either ignored noise or degraded once. */
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'server.connected',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.idle',
  'permission.asked',
  'permission.replied',
])

const IGNORED_EVENT_PREFIXES: readonly string[] = [
  'session.text.',
  'session.reasoning.',
  'session.tool.',
  'session.step.',
  'session.shell.',
  'session.inbox.',
  'session.usage.',
  'session.compaction.',
  'session.revert.',
  'session.skill.',
  'session.synthetic',
  'session.instructions.',
  'session.agent.',
  'session.model.',
  'session.metadata.',
  'session.created',
  'session.renamed',
  'session.moved',
  'session.permissions',
  'session.viewed',
  'session.archived',
  'session.unarchived',
  'session.deleted',
  'session.forked',
  'session.retry.',
  'provider.',
  'model.',
  'agent.',
  'integration.',
  'credential.',
  'models-dev.',
  'location.',
]

export function isKnownEventType(type: string): boolean {
  return (
    HANDLED_EVENT_TYPES.has(type) || IGNORED_EVENT_PREFIXES.some(prefix => type.startsWith(prefix))
  )
}

export function sessionIdOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const value = (data as { sessionID?: unknown }).sessionID
  return typeof value === 'string' ? value : null
}

export function executionOutcomeOf(type: string): TurnCompletionOutcome | null {
  if (type === 'session.execution.succeeded') {
    return 'completed'
  }
  if (type === 'session.execution.failed' || type === 'session.execution.interrupted') {
    return type === 'session.execution.failed' ? 'failed' : 'interrupted'
  }
  return null
}

export const APPROVAL_SUMMARY_LIMIT = 200

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0
    ? value.slice(0, APPROVAL_SUMMARY_LIMIT)
    : null

/** `{data:{...}}` of every v2 answer; an unexpected shape becomes an empty record for the caller. */
export function replyBodyOf(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    return {}
  }
  const data = (body as { data?: unknown }).data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

export function sessionCreatedAtOf(body: unknown): number | null {
  const time = replyBodyOf(body)['time']
  if (typeof time !== 'object' || time === null) {
    return null
  }
  const created = Number((time as { created?: unknown }).created)
  return Number.isFinite(created) ? created : null
}

/** `approve` becomes `once`, `approve_for_session` becomes `always`; `deny` and `cancel` reject. */
export function openCodeDecisionOf(decision: ApprovalDecision): 'once' | 'always' | 'reject' {
  return decision === 'approve' ? 'once' : decision === 'approve_for_session' ? 'always' : 'reject'
}

export function approvalSummaryOf(request: Record<string, unknown>): {
  kind: string
  summary: string
} {
  const message = text(request['message'])
  const resources = Array.isArray(request['resources'])
    ? request['resources'].filter((entry): entry is string => typeof entry === 'string')
    : []
  const fallback = [request['action'], resources.join(', ')]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .join(': ')
  return {
    kind: typeof request['action'] === 'string' ? request['action'] : 'permission',
    summary: message ?? text(fallback) ?? 'permission',
  }
}

export function permissionRequestsOf(body: unknown): Record<string, unknown>[] {
  if (typeof body !== 'object' || body === null) {
    return []
  }
  const data = (body as { data?: unknown }).data
  return Array.isArray(data)
    ? data.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
    : []
}

/**
 * Approvals of one service: announced once, answered once. A request answered on the screen is
 * never sent again by the Glimpse, and a repeated answer of the Glimpse stays idempotent.
 */
export class OpenCodeApprovals {
  private readonly announced = new Set<string>()
  private readonly answered = new Set<string>()
  private readonly screen = new Set<string>()

  constructor(private readonly emit: (event: ExecutorRuntimeEvent) => void) {}

  announce(request: Record<string, unknown>, turnRef: string | null): void {
    const requestId = typeof request['id'] === 'string' ? request['id'] : null
    if (requestId === null || this.announced.has(requestId)) {
      return
    }
    if (this.answered.has(requestId) || this.screen.has(requestId)) {
      return
    }
    this.announced.add(requestId)
    this.emit({ type: 'approval.requested', requestId, ...approvalSummaryOf(request), turnRef })
  }

  /** `answered` is idempotent; `screen` means the TUI won and the request is gone. */
  outcomeOf(requestId: string): 'answered' | 'screen' | null {
    if (this.answered.has(requestId)) {
      return 'answered'
    }
    return this.screen.has(requestId) ? 'screen' : null
  }

  markAnswered(requestId: string): void {
    this.answered.add(requestId)
    this.announced.delete(requestId)
    this.emit({ type: 'approval.resolved', requestId, resolvedBy: 'glimpse' })
  }

  onReplied(requestId: string): void {
    this.announced.delete(requestId)
    if (this.answered.delete(requestId)) {
      return
    }
    this.screen.add(requestId)
    this.emit({ type: 'approval.resolved', requestId, resolvedBy: 'screen' })
  }

  clear(): void {
    this.announced.clear()
  }
}

interface PendingStart {
  readonly turnRef: string
  readonly dispatchId: string
}

export interface OpenCodeTurnsDeps {
  readonly emit: (event: ExecutorRuntimeEvent) => void
  readonly sessionRef: () => string | null
  readonly readMessages: () => Promise<readonly OpenCodeMessage[]>
  readonly messageIdOf: (dispatchId: string) => string
}

/**
 * The turn of the adapter is the user message. A Glimpse dispatch is known before the server
 * accepts it, a screen turn is discovered from the newest user message of the window.
 */
export class OpenCodeTurns {
  private readonly dispatch = new Map<string, string | null>()
  private pendingStart: PendingStart | null = null
  private inFlight: PendingStart | null = null
  lastTurnRef: string | null = null

  constructor(private readonly deps: OpenCodeTurnsDeps) {}

  beginDispatch(dispatchId: string): void {
    this.inFlight = { turnRef: this.deps.messageIdOf(dispatchId), dispatchId }
  }

  endDispatch(): void {
    this.inFlight = null
  }

  accept(turnRef: string, dispatchId: string): void {
    this.pendingStart = { turnRef, dispatchId }
    this.dispatch.set(turnRef, dispatchId)
    this.lastTurnRef = turnRef
  }

  onExecutionStarted(data: Record<string, unknown>): void {
    if (sessionIdOf(data) !== this.deps.sessionRef()) {
      return
    }
    const glimpse = this.pendingStart ?? this.inFlight
    if (glimpse !== null) {
      this.pendingStart = null
      this.lastTurnRef = glimpse.turnRef
      this.deps.emit({
        type: 'turn.started',
        turnRef: glimpse.turnRef,
        dispatchId: glimpse.dispatchId,
        origin: 'glimpse',
      })
      return
    }
    void this.screenTurnStarted()
  }

  async onExecutionEnded(
    data: Record<string, unknown>,
    outcome: TurnCompletionOutcome,
  ): Promise<void> {
    if (sessionIdOf(data) !== this.deps.sessionRef()) {
      return
    }
    const turnRef = this.lastTurnRef ?? this.pendingStart?.turnRef ?? this.inFlight?.turnRef ?? null
    if (turnRef === null) {
      return
    }
    const dispatchId = this.dispatch.get(turnRef) ?? null
    const messages = await this.deps.readMessages().catch(() => [] as readonly OpenCodeMessage[])
    const user = messages.find(message => message.id === turnRef)
    const snapshot = user ? snapshotOfTurn(turnRef, user, messages) : null
    this.dispatch.delete(turnRef)
    this.lastTurnRef = null
    this.pendingStart = null
    this.deps.emit({
      type: 'turn.completed',
      turnRef,
      dispatchId,
      outcome,
      finalMessage: snapshot?.finalMessage ?? null,
      usage: snapshot?.usage ?? null,
    })
  }

  forget(): void {
    this.dispatch.clear()
    this.pendingStart = null
    this.inFlight = null
    this.lastTurnRef = null
  }

  private async screenTurnStarted(): Promise<void> {
    try {
      const messages = await this.deps.readMessages()
      const user = messages
        .filter(message => message.type === 'user')
        .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0]
      if (!user) {
        return
      }
      this.lastTurnRef = user.id
      this.deps.emit({ type: 'turn.started', turnRef: user.id, dispatchId: null, origin: 'screen' })
    } catch {
      // The next execution event carries the same information.
    }
  }
}
