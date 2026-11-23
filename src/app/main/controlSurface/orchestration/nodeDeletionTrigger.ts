import type { NormalizedPersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'

/** `sync.writeState` and `sync.writeWorkspaceStateRaw`: the base hook first, then the reconciler. */
export function createStatePersistedHook(
  base: ((state: NormalizedPersistedAppState) => Promise<void>) | undefined,
  reconcile: () => Promise<void> | undefined,
): (state: NormalizedPersistedAppState) => Promise<void> {
  return async state => {
    await base?.(state)
    await reconcile()
  }
}

/**
 * Paths that write the app state without `onStatePersisted` (`node.delete`) reach the reconciler
 * through the store. A reconciler failure never fails the write that already happened.
 */
export function notifyAfterStateWrite(
  getStore: () => Promise<PersistenceStore>,
  reconcile: () => Promise<void> | undefined,
): () => Promise<PersistenceStore> {
  return async () => {
    const store = await getStore()
    return {
      ...store,
      writeAppState: async (...args) => {
        const result = await store.writeAppState(...args)
        if (result.ok) {
          await Promise.resolve(reconcile()).catch(() => undefined)
        }
        return result
      },
    }
  }
}
