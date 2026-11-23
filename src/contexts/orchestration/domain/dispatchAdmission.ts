import { OrchestrationError, type AgentLink } from './agentLink'
import type { Dispatch } from './dispatch'
import { hasRoundAvailable } from './roundPolicy'

export type ExecutorHealth = 'starting' | 'ready' | 'busy' | 'degraded' | 'unavailable'

export type AdmissionRefusal = 'round_limit_reached' | 'executor_unavailable' | 'dispatch_in_flight'

export interface BlockingDispatch {
  readonly dispatchId: string
  readonly state: 'queued' | 'reserved' | 'sent' | 'uncertain'
  readonly round: number
}

export interface AdmissionInput {
  readonly link: AgentLink | null
  readonly health: ExecutorHealth
  /** The dispatch of the executor outside a final state, if any (D1). */
  readonly openDispatch: Dispatch | null
}

export interface DispatchAdmission {
  readonly canDispatch: boolean
  readonly reason: AdmissionRefusal | null
  readonly blocking: BlockingDispatch | null
  readonly willWait: boolean
}

function refuse(reason: AdmissionRefusal, blocking: BlockingDispatch | null = null) {
  return { canDispatch: false, reason, blocking, willWait: false }
}

function blockingOf(dispatch: Dispatch): BlockingDispatch {
  return {
    dispatchId: dispatch.id,
    state: dispatch.state as BlockingDispatch['state'],
    round: dispatch.round,
  }
}

/**
 * Rows of the admission table of the dispatch ADR, top to bottom, first match decides. Takes no
 * clock and no text, so `orch.status` and `orch.dispatch` cannot disagree.
 */
export function evaluateDispatchAdmission(input: AdmissionInput): DispatchAdmission {
  const { link, health, openDispatch } = input
  if (!link || link.state !== 'active') {
    throw new OrchestrationError('orch.not_linked')
  }
  if (!hasRoundAvailable(link)) {
    return refuse('round_limit_reached')
  }
  if (health === 'unavailable') {
    return refuse('executor_unavailable')
  }
  if (openDispatch) {
    return refuse('dispatch_in_flight', blockingOf(openDispatch))
  }
  return { canDispatch: true, reason: null, blocking: null, willWait: health !== 'ready' }
}
