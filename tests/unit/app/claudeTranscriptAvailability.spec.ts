// @vitest-environment node
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveClaudeTranscriptStatus } from '../../../src/contexts/agent/infrastructure/ClaudeTranscriptAvailability'
import { encodeClaudeProjectPath } from '../../../src/contexts/agent/infrastructure/ClaudeProjectPaths'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    // eslint-disable-next-line no-await-in-loop -- remove fixtures in reverse creation order
    await dispose()
  }
})

async function createFixture(): Promise<{
  homeDirectory: string
  cwd: string
  projectDirectory: string
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'opencove-claude-transcript-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const homeDirectory = join(root, 'home')
  const cwd = join(root, 'workspace')
  const projectDirectory = join(homeDirectory, '.claude', 'projects', encodeClaudeProjectPath(cwd))
  await fs.mkdir(cwd, { recursive: true })
  return { homeDirectory, cwd, projectDirectory }
}

async function writeTranscript(projectDirectory: string, sessionId: string): Promise<void> {
  await fs.mkdir(projectDirectory, { recursive: true })
  await fs.writeFile(join(projectDirectory, `${sessionId}.jsonl`), '{}\n')
}

describe('claude transcript availability', () => {
  it('reports present when the transcript file exists', async () => {
    const { homeDirectory, cwd, projectDirectory } = await createFixture()
    await writeTranscript(projectDirectory, 'session-1')

    await expect(
      resolveClaudeTranscriptStatus({
        cwd,
        sessionId: 'session-1',
        homeDirectories: [homeDirectory],
        configDirectory: null,
      }),
    ).resolves.toBe('present')
  })

  it('reports missing when the transcript file does not exist', async () => {
    const { homeDirectory, cwd } = await createFixture()

    await expect(
      resolveClaudeTranscriptStatus({
        cwd,
        sessionId: 'session-1',
        homeDirectories: [homeDirectory],
        configDirectory: null,
      }),
    ).resolves.toBe('missing')
  })

  it('reports missing when the project directory does not exist', async () => {
    const { homeDirectory, cwd } = await createFixture()

    await expect(
      resolveClaudeTranscriptStatus({
        cwd: join(cwd, 'nested', 'unknown'),
        sessionId: 'session-1',
        homeDirectories: [homeDirectory],
        configDirectory: null,
      }),
    ).resolves.toBe('missing')
  })

  it('reports unknown on io errors instead of treating them as absence', async () => {
    const { homeDirectory, cwd, projectDirectory } = await createFixture()
    await writeTranscript(projectDirectory, 'session-1')
    await fs.chmod(projectDirectory, 0o000)
    cleanup.push(() => fs.chmod(projectDirectory, 0o700))

    await expect(
      resolveClaudeTranscriptStatus({
        cwd,
        sessionId: 'session-1',
        homeDirectories: [homeDirectory],
        configDirectory: null,
      }),
    ).resolves.toBe('unknown')
  })

  it('finds transcripts stored for a worktree ancestor workspace', async () => {
    const { homeDirectory, cwd } = await createFixture()
    const worktreeCwd = join(cwd, '.worktrees', 'feature-a')
    await fs.mkdir(worktreeCwd, { recursive: true })
    await writeTranscript(
      join(homeDirectory, '.claude', 'projects', encodeClaudeProjectPath(cwd)),
      'session-worktree',
    )

    await expect(
      resolveClaudeTranscriptStatus({
        cwd: worktreeCwd,
        sessionId: 'session-worktree',
        homeDirectories: [homeDirectory],
        configDirectory: null,
      }),
    ).resolves.toBe('present')
  })
})
