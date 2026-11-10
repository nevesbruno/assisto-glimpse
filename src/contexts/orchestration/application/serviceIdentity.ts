import type { OrchestrationContext } from './OrchestrationService'
import { updateLink } from './linkLifecycle'
import type { ExecutorRuntime } from './ports'

/** Stores pid and token hash of the service for the orphan reaper; never fails the caller. */
export async function recordServiceIdentity(
  ctx: OrchestrationContext,
  linkId: string,
  runtime: ExecutorRuntime,
): Promise<void> {
  try {
    const identity = await runtime.serviceIdentity()
    const stored = await ctx.deps.links.findById(linkId)
    if (
      !identity ||
      !stored ||
      (stored.servicePid === identity.pid && stored.serviceTokenSha256 === identity.tokenSha256)
    ) {
      return
    }
    await updateLink(ctx, linkId, link => ({
      ...link,
      servicePid: identity.pid,
      serviceTokenSha256: identity.tokenSha256,
    }))
  } catch {
    // The orphan reaper then has less to go on; the service itself keeps working.
  }
}
