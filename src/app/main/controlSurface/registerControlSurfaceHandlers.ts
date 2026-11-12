import type { PromptDeliveryService } from '../../../contexts/agent/application/PromptDeliveryService'
import { registerAgentPromptHandlers } from './handlers/agentPromptHandlers'
import { registerWorkspaceBootstrapHandlers } from './handlers/workspaceBootstrapHandlers'
import { registerAgentRunStateHandlers } from './handlers/agentRunStateHandlers'
import { registerPluginHostHandlers } from './handlers/pluginHostHandlers'
import type { ControlSurfaceContext } from './types'
import type { PluginDistributionService } from '@contexts/plugins/application/PluginDistributionService'
import type { PluginInstallationManager } from '../../../contexts/plugins/application/PluginInstallationManager'
import type { ControlSurface } from './controlSurface'
import type { ApprovedWorkspaceStore } from '../../../contexts/workspace/infrastructure/approval/ApprovedWorkspaceStoreCore'
import type { PersistenceStore } from '../../../platform/persistence/sqlite/PersistenceStore'
import type { WebSessionManager } from './http/webSessionManager'
import type { WorkerTopologyStore } from './topology/topologyStore'
import type { MultiEndpointPtyRuntime } from './ptyStream/multiEndpointPtyRuntime'
import type { PtyStreamHub } from './ptyStream/ptyStreamHub'
import type { SyncEventPayload } from '../../../shared/contracts/dto'
import { registerSystemHandlers } from './handlers/systemHandlers'
import { registerProjectHandlers } from './handlers/projectHandlers'
import { registerSpaceHandlers } from './handlers/spaceHandlers'
import { registerFilesystemHandlers } from './handlers/filesystemHandlers'
import { registerFilesystemMountHandlers } from './handlers/filesystemMountHandlers'
import { registerGitWorktreeHandlers } from './handlers/gitWorktreeHandlers'
import { registerGitWorktreeMountHandlers } from './handlers/gitWorktreeMountHandlers'
import { registerIntegrationGitHubHandlers } from './handlers/integrationGithubHandlers'
import { registerIntegrationGitHubMountHandlers } from './handlers/integrationGithubMountHandlers'
import { registerWorktreeHandlers } from './handlers/worktreeHandlers'
import { registerWorkspaceHandlers } from './handlers/workspaceHandlers'
import { registerAgentSessionCatalogHandlers } from './handlers/agentSessionCatalogHandlers'
import { registerSessionHandlers } from './handlers/sessionHandlers'
import { registerSessionStreamingHandlers } from './handlers/sessionStreamingHandlers'
import { registerTerminalAgentActivityHandlers } from './handlers/terminalAgentActivityHandlers'
import { registerPtyMountHandlers } from './handlers/ptyMountHandlers'
import { registerSyncHandlers } from './handlers/syncHandlers'
import { registerTopologyHandlers } from './handlers/topologyHandlers'
import { registerAuthHandlers } from './handlers/authHandlers'
import { registerNodeControlHandlers } from './handlers/nodeControlHandlers'
import {
  createStatePersistedHook,
  notifyAfterStateWrite,
} from './orchestration/nodeDeletionTrigger'
import { registerOrchestrationHandlers } from './handlers/orchestrationHandlers'
import { createDirectInputGuard } from './handlers/directInputGuard'
import {
  createNodeProviderReader,
  type OrchestrationBackend,
} from './handlers/orchestrationHandlers.support'
import { registerPluginHandlers } from './handlers/pluginHandlers'
import { registerPluginCommandHandlers } from './handlers/pluginCommandHandlers'
import type { EndpointHealthService } from './topology/endpointHealthService'
import type { NormalizedPersistedAppState } from '../../../platform/persistence/sqlite/normalize'
import type {
  TerminalRecoverySpawnAdmission,
  TerminalSpawnAdmission,
} from '../../../contexts/terminal/application/TerminalRuntimeAvailability'
import { readSshConfigHosts } from './topology/sshConfigReader'
import type { AgentProviderRegistry } from '../../../contexts/agent/application/services/AgentProviderRegistry'
import type { TerminalAgentActivityEnvironmentService } from '../../../contexts/agent/infrastructure/terminal-activity/TerminalAgentActivityEnvironmentService'

export function registerControlSurfaceHandlers(
  controlSurface: ControlSurface,
  deps: {
    context: ControlSurfaceContext
    pluginDistribution?: PluginDistributionService
    plugins: PluginInstallationManager
    approvedWorkspaces: ApprovedWorkspaceStore
    userDataPath: string
    topology: WorkerTopologyStore
    webSessions: WebSessionManager
    getPersistenceStore: () => Promise<PersistenceStore>
    ptyRuntime: MultiEndpointPtyRuntime
    ptyStreamHub: PtyStreamHub
    deleteEntry?: (uri: string) => Promise<void>
    publishSyncEvent?: (payload: SyncEventPayload) => number
    closeWebsiteNode?: (nodeId: string) => Promise<void> | void
    endpointHealth: EndpointHealthService
    appVersion: string | null
    deploymentId?: string | null
    instanceId?: string
    isReady?: () => boolean
    onStatePersisted?: (state: NormalizedPersistedAppState) => Promise<void>
    restoreTerminalSession?: (input: { nodeId: string; sessionId: string }) => Promise<boolean>
    terminalSpawnAdmission: TerminalSpawnAdmission
    terminalRecoverySpawnAdmission: TerminalRecoverySpawnAdmission
    agentProviderRegistry: AgentProviderRegistry
    promptDelivery: PromptDeliveryService
    terminalAgentActivity?: TerminalAgentActivityEnvironmentService
    orchestration?: () =>
      | (OrchestrationBackend & {
          reviveExecutorTui?: (nodeId: string) => Promise<string | null>
          reconcileDeletedNodes?: () => Promise<void>
        })
      | null
  },
): void {
  const orchestrationDeps = {
    backend: deps.orchestration ?? (() => null),
    providerOfNode: createNodeProviderReader(deps.getPersistenceStore),
  }
  const guardDirectInput = createDirectInputGuard(orchestrationDeps)
  const reconcileNodes = () => deps.orchestration?.()?.reconcileDeletedNodes?.()
  registerAgentPromptHandlers(
    controlSurface,
    deps.ptyStreamHub,
    deps.promptDelivery,
    guardDirectInput,
    deps.getPersistenceStore,
  )
  registerAgentRunStateHandlers(
    controlSurface,
    deps.ptyStreamHub,
    deps.promptDelivery,
    deps.getPersistenceStore,
  )
  registerSystemHandlers(controlSurface, {
    appVersion: deps.appVersion,
    deploymentId: deps.deploymentId,
    instanceId: deps.instanceId,
    isReady: deps.isReady,
  })
  registerAuthHandlers(controlSurface, { webSessions: deps.webSessions })
  registerTopologyHandlers(controlSurface, {
    topology: deps.topology,
    approvedWorkspaces: deps.approvedWorkspaces,
    endpointHealth: deps.endpointHealth,
    readSshConfigHosts,
  })
  registerProjectHandlers(controlSurface, deps.getPersistenceStore)
  registerWorkspaceBootstrapHandlers(controlSurface, deps)
  registerSpaceHandlers(controlSurface, deps.getPersistenceStore)
  registerWorkspaceHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    userDataPath: deps.userDataPath,
  })
  registerFilesystemHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    deleteEntry: deps.deleteEntry,
  })
  registerFilesystemMountHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    topology: deps.topology,
    deleteEntry: deps.deleteEntry,
  })
  registerGitWorktreeHandlers(controlSurface, { approvedWorkspaces: deps.approvedWorkspaces })
  registerGitWorktreeMountHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    topology: deps.topology,
  })
  registerIntegrationGitHubHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
  })
  registerIntegrationGitHubMountHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    topology: deps.topology,
  })
  registerWorktreeHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    getPersistenceStore: deps.getPersistenceStore,
  })
  registerAgentSessionCatalogHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    readStore: deps.getPersistenceStore,
  })
  registerSessionHandlers(controlSurface, {
    userDataPath: deps.userDataPath,
    approvedWorkspaces: deps.approvedWorkspaces,
    getPersistenceStore: deps.getPersistenceStore,
    ptyRuntime: deps.ptyRuntime,
    ptyStreamHub: deps.ptyStreamHub,
    topology: deps.topology,
    restoreTerminalSession: deps.restoreTerminalSession,
    terminalSpawnAdmission: deps.terminalSpawnAdmission,
    terminalRecoverySpawnAdmission: deps.terminalRecoverySpawnAdmission,
    agentProviderRegistry: deps.agentProviderRegistry,
    reviveExecutorTui: async nodeId =>
      (await deps.orchestration?.()?.reviveExecutorTui?.(nodeId)) ?? null,
  })
  registerSessionStreamingHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    getPersistenceStore: deps.getPersistenceStore,
    ptyRuntime: deps.ptyRuntime,
    ptyStreamHub: deps.ptyStreamHub,
    topology: deps.topology,
    terminalSpawnAdmission: deps.terminalSpawnAdmission,
    terminalAgentActivity: deps.terminalAgentActivity,
    guardDirectInput,
  })
  registerTerminalAgentActivityHandlers(controlSurface, { ptyStreamHub: deps.ptyStreamHub })
  registerPtyMountHandlers(controlSurface, {
    approvedWorkspaces: deps.approvedWorkspaces,
    topology: deps.topology,
    ptyRuntime: deps.ptyRuntime,
    ptyStreamHub: deps.ptyStreamHub,
    terminalSpawnAdmission: deps.terminalSpawnAdmission,
    terminalAgentActivity: deps.terminalAgentActivity,
  })
  registerNodeControlHandlers(controlSurface, {
    topology: deps.topology,
    getPersistenceStore: notifyAfterStateWrite(deps.getPersistenceStore, reconcileNodes),
    publishSyncEvent: deps.publishSyncEvent,
    closeWebsiteNode: deps.closeWebsiteNode,
    closePluginNode: nodeId => deps.plugins.closeNodeViews(nodeId),
  })
  registerOrchestrationHandlers(controlSurface, orchestrationDeps)
  registerPluginHostHandlers(controlSurface, deps)
  registerPluginHandlers(controlSurface, deps.plugins, deps.pluginDistribution)
  registerPluginCommandHandlers(controlSurface, {
    plugins: deps.plugins,
    getPersistenceStore: deps.getPersistenceStore,
    publishSyncEvent: deps.publishSyncEvent,
  })
  registerSyncHandlers(controlSurface, deps.getPersistenceStore, {
    onStatePersisted: createStatePersistedHook(deps.onStatePersisted, reconcileNodes),
  })
}
