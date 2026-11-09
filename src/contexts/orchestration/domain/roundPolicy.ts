import { OrchestrationError, type AgentLink } from './agentLink'

export type RoundCounter = Pick<AgentLink, 'roundsUsed' | 'roundsLimit'>

export type RoundExtension = 1 | 2

export function hasRoundAvailable(counter: RoundCounter): boolean {
  return counter.roundsUsed < counter.roundsLimit
}

export function consumeRound(counter: RoundCounter): RoundCounter {
  if (!hasRoundAvailable(counter)) {
    throw new OrchestrationError('orch.round_limit_reached')
  }
  return { roundsUsed: counter.roundsUsed + 1, roundsLimit: counter.roundsLimit }
}

export function returnRound(counter: RoundCounter): RoundCounter {
  return { roundsUsed: Math.max(0, counter.roundsUsed - 1), roundsLimit: counter.roundsLimit }
}

export function extendRounds(counter: RoundCounter, rounds: RoundExtension): RoundCounter {
  return { roundsUsed: counter.roundsUsed, roundsLimit: counter.roundsLimit + rounds }
}
