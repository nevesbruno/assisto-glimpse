// @vitest-environment node
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentLaunch } from '../../../src/app/main/controlSurface/handlers/prepareAgentLaunch'
import { createTestAgentProviderRegistry } from '../contexts/controlSurfaceTestTerminalAvailability'
import { encodeClaudeProjectPath } from '../../../src/contexts/agent/infrastructure/ClaudeProjectPaths'

const SESSION_ID = 'ea173f4f-2ff3-41d4-9f89-ae46cf26a821'

let root: string
let homeDirectory: string
let cwd: string
let projectDirectory: string

async function launch(mode: 'new' | 'resume' = 'resume') {
  return await prepareAgentLaunch({
    registry: createTestAgentProviderRegistry(),
    profileId: null,
    provider: 'claude-code',
    cwd,
    mode,
    model: null,
    resumeSessionId: SESSION_ID,
    prompt: 'investigate the failing lane',
    agentFullAccess: true,
    codexReuseRunningAppServer: false,
    opencodeServer: null,
    executablePathOverride: null,
  })
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'opencove-prepare-agent-launch-'))
  homeDirectory = join(root, 'home')
  cwd = join(root, 'workspace')
  projectDirectory = join(homeDirectory, '.claude', 'projects', encodeClaudeProjectPath(cwd))
  await fs.mkdir(cwd, { recursive: true })
  vi.stubEnv('HOME', homeDirectory)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.stubEnv('OPENCOVE_TEST_USE_REAL_AGENTS', '1')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})

describe('prepareAgentLaunch claude resume fallback', () => {
  it('falls back to a new plan with the same session id when the transcript is missing', async () => {
    const prepared = await launch()

    expect(prepared.managedLaunch.plan.launchMode).toBe('new')
    expect(prepared.launchCommand.launchMode).toBe('new')
    expect(prepared.launchCommand.resumeSessionId).toBe(SESSION_ID)
    expect(prepared.launchCommand.args).toContain('--session-id')
    expect(prepared.launchCommand.args).toContain(SESSION_ID)
    expect(prepared.launchCommand.args).not.toContain('--resume')
  })

  it('keeps resume when the transcript exists', async () => {
    await fs.mkdir(projectDirectory, { recursive: true })
    await fs.writeFile(join(projectDirectory, `${SESSION_ID}.jsonl`), '{}\n')

    const prepared = await launch()

    expect(prepared.managedLaunch.plan.launchMode).toBe('resume')
    expect(prepared.launchCommand.args).toContain('--resume')
    expect(prepared.launchCommand.args).toContain(SESSION_ID)
    expect(prepared.launchCommand.args).not.toContain('--session-id')
  })

  it('keeps resume when the transcript check fails with an io error', async () => {
    await fs.mkdir(projectDirectory, { recursive: true })
    await fs.writeFile(join(projectDirectory, `${SESSION_ID}.jsonl`), '{}\n')
    await fs.chmod(projectDirectory, 0o000)

    try {
      const prepared = await launch()

      expect(prepared.managedLaunch.plan.launchMode).toBe('resume')
      expect(prepared.launchCommand.args).toContain('--resume')
    } finally {
      await fs.chmod(projectDirectory, 0o700)
    }
  })

  it('does not inspect transcripts for a requested new launch', async () => {
    const prepared = await launch('new')

    expect(prepared.managedLaunch.plan.launchMode).toBe('new')
    expect(prepared.launchCommand.args).toContain('--session-id')
    expect(prepared.launchCommand.args).not.toContain('--resume')
  })
})
