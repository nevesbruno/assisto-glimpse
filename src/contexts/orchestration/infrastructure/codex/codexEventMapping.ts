import type {
  ApprovalDecision,
  ExecutorRuntimeEvent,
  ExecutorTurnSnapshot,
  ExecutorTurnStatus,
  TurnCompletionOutcome,
} from '../../application/ports/executorRuntime'
import type { CodexThreadTurn } from './protocol/codexProtocol'

const SUMMARY_LIMIT = 200

export type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'mcpServer/elicitation/request'

export const APPROVAL_METHODS: readonly ApprovalMethod[] = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
]

export function mapTurnStatus(status: CodexThreadTurn['status']): ExecutorTurnStatus {
  return status === 'inProgress' ? 'running' : status
}

export function mapCompletionOutcome(status: CodexThreadTurn['status']): TurnCompletionOutcome {
  return status === 'inProgress' ? 'failed' : status
}

export function lastAgentMessage(turn: CodexThreadTurn): string | null {
  const texts = (turn.items ?? []).filter(item => item.type === 'agentMessage')
  return texts.at(-1)?.text ?? null
}

/** The Glimpse sends `clientUserMessageId`, which the server echoes as `clientId` of the userMessage. */
export function dispatchIdOfTurn(turn: CodexThreadTurn): string | null {
  const user = (turn.items ?? []).find(item => item.type === 'userMessage' && item.clientId)
  return user?.clientId ?? null
}

export function snapshotOfTurn(turn: CodexThreadTurn): ExecutorTurnSnapshot {
  return {
    turnRef: turn.id,
    status: mapTurnStatus(turn.status),
    finalMessage: lastAgentMessage(turn),
    usage: null,
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, SUMMARY_LIMIT) : null

export function describeApproval(
  method: ApprovalMethod,
  params: Record<string, unknown>,
): { kind: string; summary: string } {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { kind: 'command', summary: text(params.command) ?? text(params.reason) ?? 'command' }
    case 'item/fileChange/requestApproval':
      return { kind: 'file_change', summary: text(params.reason) ?? 'file change' }
    case 'item/permissions/requestApproval':
      return { kind: 'permissions', summary: text(params.reason) ?? 'permissions' }
    default:
      return { kind: 'elicitation', summary: text(params.message) ?? 'elicitation' }
  }
}

const ITEM_DECISION: Record<ApprovalDecision, string> = {
  approve: 'accept',
  approve_for_session: 'acceptForSession',
  deny: 'decline',
  cancel: 'cancel',
}

const ELICITATION_ACTION: Record<ApprovalDecision, string> = {
  approve: 'accept',
  approve_for_session: 'accept',
  deny: 'decline',
  cancel: 'cancel',
}

/** The answer of the server request in the shape of its method. */
export function approvalResponse(
  method: ApprovalMethod,
  decision: ApprovalDecision,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === 'mcpServer/elicitation/request') {
    return { action: ELICITATION_ACTION[decision], content: null }
  }
  if (method === 'item/permissions/requestApproval') {
    const granted = decision === 'approve' || decision === 'approve_for_session'
    return {
      permissions: granted ? (params.permissions ?? {}) : {},
      scope: decision === 'approve_for_session' ? 'session' : 'turn',
    }
  }
  return { decision: ITEM_DECISION[decision] }
}

interface PendingApproval {
  readonly method: ApprovalMethod
  readonly params: Record<string, unknown>
  readonly turnRef: string | null
  readonly resolve: (response: unknown) => void
}

export type ApprovalReply =
  | { readonly outcome: 'answered'; readonly turnRef: string | null }
  | { readonly outcome: 'repeated' }
  | { readonly outcome: 'missing' }

/** Server requests held without an automatic answer until the user or the screen closes them. */
export class PendingApprovals {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly answered = new Set<string>()

  hold(
    method: ApprovalMethod,
    params: unknown,
    requestId: string | number,
    announce: (event: ExecutorRuntimeEvent) => void,
  ): Promise<unknown> {
    const id = String(requestId)
    const record =
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
    const turnRef = typeof record.turnId === 'string' ? record.turnId : null
    return new Promise(resolve => {
      this.pending.set(id, { method, params: record, turnRef, resolve })
      announce({
        type: 'approval.requested',
        requestId: id,
        turnRef,
        ...describeApproval(method, record),
      })
    })
  }

  respond(requestId: string, decision: ApprovalDecision): ApprovalReply {
    const entry = this.pending.get(requestId)
    if (!entry) {
      return { outcome: this.answered.has(requestId) ? 'repeated' : 'missing' }
    }
    this.pending.delete(requestId)
    this.answered.add(requestId)
    entry.resolve(approvalResponse(entry.method, decision, entry.params))
    return { outcome: 'answered', turnRef: entry.turnRef }
  }

  /** The screen answered first; the held request is released with a neutral cancel. */
  closeFromScreen(requestId: string): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) {
      return false
    }
    this.pending.delete(requestId)
    entry.resolve(approvalResponse(entry.method, 'cancel', entry.params))
    return true
  }

  clear(): void {
    this.pending.clear()
  }
}
