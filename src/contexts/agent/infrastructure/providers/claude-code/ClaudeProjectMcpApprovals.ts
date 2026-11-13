import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClaudeProjectMcpApprovals {
  readonly enableAllProjectMcpServers?: boolean
  readonly enabledMcpjsonServers?: readonly string[]
  readonly disabledMcpjsonServers?: readonly string[]
}

export interface ClaudeProjectMcpApprovalSourcePaths {
  readonly localSettingsPath?: string
  readonly projectSettingsPath?: string
  readonly userSettingsPath?: string
}

export function resolveClaudeProjectMcpApprovalSourcePaths(
  workspaceDirectory: string,
): Required<ClaudeProjectMcpApprovalSourcePaths> {
  return {
    localSettingsPath: join(workspaceDirectory, '.claude', 'settings.local.json'),
    projectSettingsPath: join(workspaceDirectory, '.claude', 'settings.json'),
    userSettingsPath: join(homedir(), '.claude', 'settings.json'),
  }
}

/**
 * Reads only the MCP approval keys that Claude Code applies on top of a temporary
 * `--settings` file. Higher-precedence files win per key: project-local, project,
 * then user. Missing or malformed files are ignored.
 */
export async function readClaudeProjectMcpApprovals(
  workspaceDirectory: string,
  overrides: ClaudeProjectMcpApprovalSourcePaths = {},
): Promise<ClaudeProjectMcpApprovals> {
  const defaults = resolveClaudeProjectMcpApprovalSourcePaths(workspaceDirectory)
  const sources = [
    overrides.localSettingsPath ?? defaults.localSettingsPath,
    overrides.projectSettingsPath ?? defaults.projectSettingsPath,
    overrides.userSettingsPath ?? defaults.userSettingsPath,
  ]
  const approvals: {
    enableAllProjectMcpServers?: boolean
    enabledMcpjsonServers?: readonly string[]
    disabledMcpjsonServers?: readonly string[]
  } = {}

  const settingsSources = await Promise.all(sources.map(source => readJsonObject(source)))

  for (const settings of settingsSources) {
    if (!settings) {
      continue
    }

    if (approvals.enableAllProjectMcpServers === undefined) {
      const value = settings.enableAllProjectMcpServers
      if (typeof value === 'boolean') {
        approvals.enableAllProjectMcpServers = value
      }
    }
    if (approvals.enabledMcpjsonServers === undefined) {
      const value = readStringArray(settings.enabledMcpjsonServers)
      if (value) {
        approvals.enabledMcpjsonServers = value
      }
    }
    if (approvals.disabledMcpjsonServers === undefined) {
      const value = readStringArray(settings.disabledMcpjsonServers)
      if (value) {
        approvals.disabledMcpjsonServers = value
      }
    }
  }

  return approvals
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.every((item): item is string => typeof item === 'string') ? value : undefined
}
