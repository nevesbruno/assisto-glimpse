import { getCommandExecutionEnvironment } from '../../../../platform/os/CommandEnvironmentService'
import type { AgentProviderRegistry } from '../../../../contexts/agent/application/services/AgentProviderRegistry'
import { createManagedAgentLaunchPlan } from '../../../../contexts/agent/application/use-cases/createManagedAgentLaunchPlan'
import { resolveClaudeTranscriptStatus } from '../../../../contexts/agent/infrastructure/ClaudeTranscriptAvailability'
import type { AgentLaunchCommand } from '../../../../contexts/agent/infrastructure/cli/AgentCommandFactory'
import type { AgentLaunchMode, AgentProviderId } from '../../../../shared/contracts/dto'
import { resolveWorkerAgentTestStub } from './sessionAgentTestStub'

async function resolveEffectiveLaunchMode(options: {
  configDirectory: string | null | undefined
  cwd: string
  mode: AgentLaunchMode
  provider: AgentProviderId
  resumeSessionId: string | null
}): Promise<AgentLaunchMode> {
  if (
    options.provider !== 'claude-code' ||
    options.mode !== 'resume' ||
    !options.resumeSessionId?.trim()
  ) {
    return options.mode
  }

  const transcriptStatus = await resolveClaudeTranscriptStatus({
    cwd: options.cwd,
    sessionId: options.resumeSessionId,
    configDirectory: options.configDirectory,
  })

  return transcriptStatus === 'missing' ? 'new' : 'resume'
}

export async function prepareAgentLaunch(options: {
  environment?: NodeJS.ProcessEnv
  profileId?: string | null
  agentFullAccess: boolean
  codexReuseRunningAppServer: boolean
  cwd: string
  executablePathOverride: string | null
  mode: AgentLaunchMode
  model: string | null
  opencodeServer: { hostname: string; port: number } | null
  prompt: string
  provider: AgentProviderId
  registry: AgentProviderRegistry
  resumeSessionId: string | null
}) {
  const environment = await getCommandExecutionEnvironment(options.environment)
  const launchMode = await resolveEffectiveLaunchMode({
    configDirectory: environment.CLAUDE_CONFIG_DIR,
    cwd: options.cwd,
    mode: options.mode,
    provider: options.provider,
    resumeSessionId: options.resumeSessionId,
  })
  const managedLaunch = await createManagedAgentLaunchPlan(
    options.registry.require(options.provider),
    {
      environment,
      profileId: options.profileId,
      mode: launchMode,
      prompt: options.mode === 'new' ? options.prompt : '',
      model: options.model,
      resumeSessionId: options.resumeSessionId,
      sessionIdOverride:
        launchMode === 'new' && options.mode === 'resume' ? options.resumeSessionId : null,
      agentFullAccess: options.agentFullAccess,
      codexReuseRunningAppServer: options.codexReuseRunningAppServer,
      opencodeServer: options.opencodeServer,
      executablePathOverride: options.executablePathOverride,
      workspaceDirectory: options.cwd,
    },
  )
  const testStub = resolveWorkerAgentTestStub({
    provider: options.provider,
    cwd: options.cwd,
    mode: launchMode,
    model: options.model,
    resumeSessionId: managedLaunch.plan.resumeSessionId,
  })
  const launchCommand: AgentLaunchCommand = testStub
    ? {
        command: testStub.command,
        args:
          process.env.OPENCOVE_TEST_AGENT_SESSION_SCENARIO === 'claude-prompt-strict'
            ? [...testStub.args, ...managedLaunch.plan.args]
            : testStub.args,
        effectiveModel: managedLaunch.plan.effectiveModel,
        launchMode: managedLaunch.plan.launchMode,
        resumeSessionId: managedLaunch.plan.resumeSessionId,
      }
    : { ...managedLaunch.plan, args: [...managedLaunch.plan.args] }

  return { launchCommand, managedLaunch, testStub }
}
