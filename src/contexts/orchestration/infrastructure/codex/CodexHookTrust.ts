import type { HookKeyHash } from '../../application/ports/repositories'
import type { HookTrustPending } from '../../application/ports/executorRuntime'
import type { CodexHookMetadata } from './protocol/codexProtocol'
import type { CodexHookTrust } from './codexProcessEnv'

/** One override per key; a later approved hash for the same key replaces the earlier one. */
export function hookOverridesFromApproved(approved: readonly HookKeyHash[]): CodexHookTrust[] {
  const byKey = new Map<string, string>()
  for (const pair of approved) {
    byKey.set(pair.key, pair.currentHash)
  }
  return [...byKey].map(([key, trustedHash]) => ({ key, trustedHash }))
}

/** Hooks the user has not trusted and that the Glimpse has not approved for the exact hash. */
export function findPendingHooks(
  listed: readonly CodexHookMetadata[],
  approved: readonly HookKeyHash[],
): HookTrustPending[] {
  const approvedPairs = new Set(approved.map(pair => `${pair.key}\u0000${pair.currentHash}`))
  return listed
    .filter(hook => hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified')
    .filter(hook => !approvedPairs.has(`${hook.key}\u0000${hook.currentHash}`))
    .map(hook => ({
      key: hook.key,
      event: hook.eventName,
      origin: hook.trustStatus,
      currentHash: hook.currentHash,
    }))
}
