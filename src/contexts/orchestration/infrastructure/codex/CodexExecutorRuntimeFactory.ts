import type {
  ExecutorProbeResult,
  ExecutorRuntimeFactory,
  ExecutorStartSpec,
} from '../../application/ports/executorRuntime'
import { buildCodexProcessEnv } from './codexProcessEnv'
import { CodexExecutorRuntime, type CodexRuntimeCollaborators } from './CodexExecutorRuntime'

export const MIN_CODEX_VERSION = '0.167.0'

export interface CodexFactoryDeps extends CodexRuntimeCollaborators {
  resolveExecutable: () => Promise<{ executablePath: string; version: string }>
  /** Option of full access of the common windows; read at each start, never from `policy.sandbox`. */
  readFullAccess: () => boolean
  baseEnv?: Readonly<Record<string, string | undefined>>
}

function versionParts(version: string): number[] {
  return (/(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number)
}

export function isCompatibleCodexVersion(version: string): boolean {
  const have = versionParts(version)
  const need = versionParts(MIN_CODEX_VERSION)
  if (have.length !== 3) {
    return false
  }
  const diff = need.findIndex((part, index) => have[index] !== part)
  return diff === -1 || have[diff] > need[diff]
}

export function createCodexExecutorRuntimeFactory(deps: CodexFactoryDeps): ExecutorRuntimeFactory {
  return {
    async probe(): Promise<ExecutorProbeResult> {
      const { executablePath, version } = await deps.resolveExecutable()
      return { executablePath, version, compatible: isCompatibleCodexVersion(version) }
    },
    async start(spec: ExecutorStartSpec) {
      const { executablePath, version } = await deps.resolveExecutable()
      const fullAccess = deps.readFullAccess()
      const runtime = new CodexExecutorRuntime(deps, {
        spec,
        executablePath,
        version,
        env: buildCodexProcessEnv(deps.baseEnv ?? process.env, spec.env),
        sandbox: fullAccess ? 'danger-full-access' : 'workspace-write',
        approvalPolicy: fullAccess ? 'never' : 'on-request',
      })
      await runtime.start()
      return runtime
    },
  }
}
