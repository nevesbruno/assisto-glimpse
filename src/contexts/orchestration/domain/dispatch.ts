import { OrchestrationError, type AgentLink } from './agentLink'
import { consumeRound, type RoundCounter } from './roundPolicy'

export type DispatchState =
  | 'queued'
  | 'reserved'
  | 'sent'
  | 'uncertain'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type DispatchFailureReason = 'not_sent' | 'executor_down' | 'turn_failed' | 'interrupted'
export type DispatchOutcome = 'completed' | 'failed' | 'interrupted'

export const DISPATCH_TEXT_MAX_BYTES = 32_768
export const DEFAULT_DEADLINE_MS = 30 * 60_000

const FINAL_STATES: readonly DispatchState[] = ['completed', 'failed', 'cancelled']

export interface Dispatch {
  readonly id: string
  readonly linkId: string
  readonly executorNodeId: string
  readonly orchestratorNodeId: string
  readonly round: number
  readonly state: DispatchState
  readonly reason: DispatchFailureReason | null
  readonly text: string | null
  readonly textSha256: string
  readonly textBytes: number
  readonly deadlineAt: string
  readonly turnRef: string | null
  readonly glimpseTurnId: string | null
  readonly outcome: DispatchOutcome | null
  readonly finalExcerpt: string | null
  readonly finalChars: number | null
  readonly createdAt: string
  readonly reservedAt: string | null
  readonly sentAt: string | null
  readonly finishedAt: string | null
  readonly revision: number
}

export type DispatchRuleErrorCode = 'invalid_transition' | 'invalid_text'

export class DispatchRuleError extends Error {
  public constructor(
    public readonly code: DispatchRuleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DispatchRuleError'
  }
}

export function isFinalDispatchState(state: DispatchState): boolean {
  return FINAL_STATES.includes(state)
}

export function isInFlightDispatchState(state: DispatchState): boolean {
  return state === 'reserved' || state === 'sent' || state === 'uncertain'
}

export interface CreateDispatchInput {
  readonly id: string
  readonly link: AgentLink
  readonly text: string
  readonly textSha256: string
  readonly deadlineMs?: number
  readonly now: Date
}

export interface CreatedDispatch {
  readonly dispatch: Dispatch
  readonly rounds: RoundCounter
}

/** Returns the size in utf-8 bytes of a text the dispatch accepts. */
export function assertDispatchText(text: string): number {
  const bytes = new TextEncoder().encode(text).length
  if (bytes < 1 || bytes > DISPATCH_TEXT_MAX_BYTES) {
    throw new DispatchRuleError(
      'invalid_text',
      `text must have 1 to ${DISPATCH_TEXT_MAX_BYTES} bytes`,
    )
  }
  return bytes
}

export function createDispatch(input: CreateDispatchInput): CreatedDispatch {
  const { link, text, now } = input
  if (link.state !== 'active') {
    throw new OrchestrationError('orch.not_linked')
  }
  const bytes = assertDispatchText(text)
  const rounds = consumeRound(link)
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS
  return {
    rounds,
    dispatch: {
      id: input.id,
      linkId: link.id,
      executorNodeId: link.executorNodeId,
      orchestratorNodeId: link.orchestratorNodeId,
      round: rounds.roundsUsed,
      state: 'queued',
      reason: null,
      text,
      textSha256: input.textSha256,
      textBytes: bytes,
      deadlineAt: new Date(now.getTime() + deadlineMs).toISOString(),
      turnRef: null,
      glimpseTurnId: null,
      outcome: null,
      finalExcerpt: null,
      finalChars: null,
      createdAt: now.toISOString(),
      reservedAt: null,
      sentAt: null,
      finishedAt: null,
      revision: 1,
    },
  }
}

export interface TurnResult {
  readonly outcome: DispatchOutcome
  readonly finalExcerpt: string | null
  readonly finalChars: number | null
  readonly glimpseTurnId?: string | null
}

type TurnFinishedEvent = { readonly type: 'turn_finished'; readonly now: Date } & TurnResult

export type DispatchEvent =
  | { readonly type: 'reserve'; readonly now: Date }
  | { readonly type: 'cancel'; readonly now: Date }
  | {
      readonly type: 'service_accepted'
      readonly turnRef: string
      readonly glimpseTurnId?: string | null
      readonly now: Date
    }
  | { readonly type: 'service_rejected'; readonly now: Date }
  | { readonly type: 'send_uncertain'; readonly now: Date }
  | {
      readonly type: 'turn_found_running'
      readonly turnRef: string
      readonly glimpseTurnId?: string | null
      readonly now: Date
    }
  | TurnFinishedEvent
  | { readonly type: 'turn_absent'; readonly now: Date }
  | { readonly type: 'executor_down'; readonly now: Date }
  | { readonly type: 'executor_unavailable'; readonly now: Date }

export interface DispatchTransition {
  readonly dispatch: Dispatch
  readonly returnsRound: boolean
}

function bump(dispatch: Dispatch, patch: Partial<Dispatch>): Dispatch {
  return { ...dispatch, ...patch, revision: dispatch.revision + 1 }
}

function finish(
  dispatch: Dispatch,
  state: 'completed' | 'failed' | 'cancelled',
  reason: DispatchFailureReason | null,
  now: Date,
  patch: Partial<Dispatch> = {},
): Dispatch {
  return bump(dispatch, {
    state,
    reason,
    text: null,
    finishedAt: now.toISOString(),
    ...patch,
  })
}

function finishTurn(dispatch: Dispatch, event: TurnFinishedEvent): Dispatch {
  const summary: Partial<Dispatch> = {
    outcome: event.outcome,
    finalExcerpt: event.finalExcerpt,
    finalChars: event.finalChars,
    ...(event.glimpseTurnId === undefined ? {} : { glimpseTurnId: event.glimpseTurnId }),
  }
  if (event.outcome === 'completed') {
    return finish(dispatch, 'completed', null, event.now, summary)
  }
  const reason = event.outcome === 'interrupted' ? 'interrupted' : 'turn_failed'
  return finish(dispatch, 'failed', reason, event.now, summary)
}

function applyEvent(dispatch: Dispatch, event: DispatchEvent): DispatchTransition | null {
  const keep = (next: Dispatch): DispatchTransition => ({ dispatch: next, returnsRound: false })
  const refund = (next: Dispatch): DispatchTransition => ({ dispatch: next, returnsRound: true })
  const { state } = dispatch

  switch (event.type) {
    case 'reserve':
      return state === 'queued'
        ? keep(bump(dispatch, { state: 'reserved', reservedAt: event.now.toISOString() }))
        : null
    case 'cancel':
      return state === 'queued' ? refund(finish(dispatch, 'cancelled', null, event.now)) : null
    case 'service_accepted':
      return state === 'reserved'
        ? keep(
            bump(dispatch, {
              state: 'sent',
              text: null,
              turnRef: event.turnRef,
              glimpseTurnId: event.glimpseTurnId ?? dispatch.glimpseTurnId,
              sentAt: event.now.toISOString(),
            }),
          )
        : null
    case 'service_rejected':
      return state === 'reserved' ? refund(finish(dispatch, 'failed', 'not_sent', event.now)) : null
    case 'send_uncertain':
      return state === 'reserved' ? keep(bump(dispatch, { state: 'uncertain', text: null })) : null
    case 'turn_found_running':
      return state === 'uncertain'
        ? keep(
            bump(dispatch, {
              state: 'sent',
              turnRef: event.turnRef,
              glimpseTurnId: event.glimpseTurnId ?? dispatch.glimpseTurnId,
              sentAt: dispatch.sentAt ?? event.now.toISOString(),
            }),
          )
        : null
    case 'turn_finished':
      return state === 'uncertain' || state === 'sent' ? keep(finishTurn(dispatch, event)) : null
    case 'turn_absent':
      return state === 'uncertain'
        ? refund(finish(dispatch, 'failed', 'not_sent', event.now))
        : null
    case 'executor_unavailable':
      return state === 'queued' ? refund(finish(dispatch, 'failed', 'not_sent', event.now)) : null
    case 'executor_down':
      return state === 'uncertain' || state === 'sent'
        ? keep(finish(dispatch, 'failed', 'executor_down', event.now))
        : null
  }
}

export function transitionDispatch(dispatch: Dispatch, event: DispatchEvent): DispatchTransition {
  const result = applyEvent(dispatch, event)
  if (!result) {
    throw new DispatchRuleError(
      'invalid_transition',
      `event ${event.type} is not allowed from ${dispatch.state}`,
    )
  }
  return result
}

export function isDeadlineExceeded(dispatch: Dispatch, now: Date): boolean {
  return dispatch.state === 'sent' && now.getTime() > Date.parse(dispatch.deadlineAt)
}

export interface DispatchRequestIdentity {
  readonly id: string
  readonly executorNodeId: string
  readonly textSha256: string
}

export type DispatchRequestClassification =
  | { readonly kind: 'new' }
  | { readonly kind: 'duplicate'; readonly dispatch: Dispatch }

export function classifyDispatchRequest(
  request: DispatchRequestIdentity,
  existing: readonly Dispatch[],
): DispatchRequestClassification {
  const sameId = existing.find(dispatch => dispatch.id === request.id)
  if (sameId) {
    if (
      sameId.textSha256 !== request.textSha256 ||
      sameId.executorNodeId !== request.executorNodeId
    ) {
      throw new OrchestrationError('orch.dispatch_conflict')
    }
    return { kind: 'duplicate', dispatch: sameId }
  }
  return { kind: 'new' }
}
