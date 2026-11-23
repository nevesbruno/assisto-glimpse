import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readClaudeProjectMcpApprovals,
  resolveClaudeProjectMcpApprovalSourcePaths,
} from '../../../src/contexts/agent/infrastructure/providers/claude-code/ClaudeProjectMcpApprovals'

describe('readClaudeProjectMcpApprovals', () => {
  let root: string
  let workspace: string
  let userSettingsPath: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'opencove-claude-mcp-approvals-'))
    workspace = join(root, 'workspace')
    userSettingsPath = join(root, 'home', '.claude', 'settings.json')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  function sourcePaths() {
    return {
      localSettingsPath: join(workspace, '.claude', 'settings.local.json'),
      projectSettingsPath: join(workspace, '.claude', 'settings.json'),
      userSettingsPath,
    }
  }

  async function writeSettings(path: string, settings: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      typeof settings === 'string' ? settings : JSON.stringify(settings),
      'utf8',
    )
  }

  it('returns exactly the three approval keys from project-local settings', async () => {
    await writeSettings(sourcePaths().localSettingsPath, {
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['kan', 'esteira_chat'],
      disabledMcpjsonServers: ['esteira_chat'],
    })

    await expect(readClaudeProjectMcpApprovals(workspace, sourcePaths())).resolves.toEqual({
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['kan', 'esteira_chat'],
      disabledMcpjsonServers: ['esteira_chat'],
    })
  })

  it('falls back to project settings when local settings are absent', async () => {
    await writeSettings(sourcePaths().projectSettingsPath, {
      enableAllProjectMcpServers: false,
      enabledMcpjsonServers: ['kan'],
    })

    await expect(readClaudeProjectMcpApprovals(workspace, sourcePaths())).resolves.toEqual({
      enableAllProjectMcpServers: false,
      enabledMcpjsonServers: ['kan'],
    })
  })

  it('returns approvals from the injected user settings', async () => {
    await writeSettings(userSettingsPath, {
      enableAllProjectMcpServers: true,
      disabledMcpjsonServers: ['esteira_chat'],
    })

    await expect(readClaudeProjectMcpApprovals(workspace, sourcePaths())).resolves.toEqual({
      enableAllProjectMcpServers: true,
      disabledMcpjsonServers: ['esteira_chat'],
    })
  })

  it('reads user settings from the effective home directory by default', async () => {
    const home = join(root, 'home')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    await writeSettings(join(home, '.claude', 'settings.json'), {
      enabledMcpjsonServers: ['kan'],
    })

    await expect(readClaudeProjectMcpApprovals(workspace)).resolves.toEqual({
      enabledMcpjsonServers: ['kan'],
    })
  })

  it('applies local, then project, then user precedence per key', async () => {
    const paths = sourcePaths()
    await writeSettings(paths.localSettingsPath, {
      enableAllProjectMcpServers: true,
    })
    await writeSettings(paths.projectSettingsPath, {
      enableAllProjectMcpServers: false,
      enabledMcpjsonServers: ['kan'],
    })
    await writeSettings(paths.userSettingsPath, {
      enableAllProjectMcpServers: false,
      enabledMcpjsonServers: ['from-user'],
      disabledMcpjsonServers: ['esteira_chat'],
    })

    await expect(readClaudeProjectMcpApprovals(workspace, paths)).resolves.toEqual({
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['kan'],
      disabledMcpjsonServers: ['esteira_chat'],
    })
  })

  it('returns an empty object for malformed JSON without throwing', async () => {
    await writeSettings(sourcePaths().localSettingsPath, '{ not valid json')

    await expect(readClaudeProjectMcpApprovals(workspace, sourcePaths())).resolves.toEqual({})
  })

  it('returns an empty object when every settings file is missing', async () => {
    await expect(readClaudeProjectMcpApprovals(workspace, sourcePaths())).resolves.toEqual({})
  })

  it('does not copy permissions, env, or unrelated keys', async () => {
    await writeSettings(sourcePaths().localSettingsPath, {
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['kan'],
      permissions: { allow: ['Bash(rm -rf *)'] },
      env: { ANTHROPIC_API_KEY: 'user-secret' },
      model: 'opus',
    })

    const approvals = await readClaudeProjectMcpApprovals(workspace, sourcePaths())

    expect(approvals).toEqual({
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['kan'],
    })
    expect(Object.keys(approvals).sort()).toEqual([
      'enableAllProjectMcpServers',
      'enabledMcpjsonServers',
    ])
  })

  it('ignores invalid values and lets lower-precedence files provide the key', async () => {
    const paths = sourcePaths()
    await writeSettings(paths.localSettingsPath, {
      enableAllProjectMcpServers: 'yes',
      enabledMcpjsonServers: ['kan', 42],
    })
    await writeSettings(paths.projectSettingsPath, {
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['esteira_chat'],
    })

    await expect(readClaudeProjectMcpApprovals(workspace, paths)).resolves.toEqual({
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['esteira_chat'],
    })
  })

  it('resolves the documented default source paths from the workspace and home', () => {
    const home = join(root, 'home')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)

    expect(resolveClaudeProjectMcpApprovalSourcePaths(workspace)).toEqual({
      localSettingsPath: join(workspace, '.claude', 'settings.local.json'),
      projectSettingsPath: join(workspace, '.claude', 'settings.json'),
      userSettingsPath: join(home, '.claude', 'settings.json'),
    })
  })
})
