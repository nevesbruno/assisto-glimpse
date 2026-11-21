import type { AgentLaunchMode, GetSessionResult } from '../../../../shared/contracts/dto'
import type { GeminiSessionDiscoveryCursor } from '../../../../contexts/agent/infrastructure/cli/AgentSessionLocatorProviders'

export type SessionRoute =
  | {
      kind: 'local'
    }
  | {
      kind: 'remote'
      endpointId: string
      remoteSessionId: string
    }

export type SessionRecord = GetSessionResult & {
  startedAtMs: number
  route: SessionRoute
  launchMode?: AgentLaunchMode
  geminiDiscoveryCursor?: GeminiSessionDiscoveryCursor | null
  /** Project of the session grant that admitted this launch; null for user and bearer launches. */
  grantProjectId?: string | null
}
