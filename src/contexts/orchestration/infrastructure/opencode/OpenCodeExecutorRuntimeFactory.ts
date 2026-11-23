import type {
  ExecutorProbeResult,
  ExecutorRuntimeFactory,
  ExecutorStartSpec,
} from '../../application/ports/executorRuntime'
import {
  OpenCodeExecutorRuntime,
  type OpenCodeRuntimeCollaborators,
} from './OpenCodeExecutorRuntime'
import { buildOpenCodeProcessEnv } from './openCodeProcessEnv'

export const MIN_OPEN_CODE_VERSION = '2.2.6'

export interface OpenCodeFactoryDeps extends OpenCodeRuntimeCollaborators {
  resolveExecutable: () => Promise<{ executablePath: string; version: string }>
  baseEnv?: Readonly<Record<string, string | undefined>>
}

function versionParts(version: string): number[] {
  return (/(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number)
}

export function isCompatibleOpenCodeVersion(version: string): boolean {
  const have = versionParts(version)
  const need = versionParts(MIN_OPEN_CODE_VERSION)
  if (have.length !== 3) {
    return false
  }
  const diff = need.findIndex((part, index) => have[index] !== part)
  return diff === -1 || have[diff] > need[diff]
}

export function createOpenCodeExecutorRuntimeFactory(
  deps: OpenCodeFactoryDeps,
): ExecutorRuntimeFactory {
  return {
    async probe(): Promise<ExecutorProbeResult> {
      const { executablePath, version } = await deps.resolveExecutable()
      return { executablePath, version, compatible: isCompatibleOpenCodeVersion(version) }
    },
    async start(spec: ExecutorStartSpec) {
      const { executablePath, version } = await deps.resolveExecutable()
      const runtime = new OpenCodeExecutorRuntime(deps, {
        spec,
        executablePath,
        version,
        env: buildOpenCodeProcessEnv(deps.baseEnv ?? process.env, spec.env),
      })
      await runtime.start()
      return runtime
    },
  }
}
