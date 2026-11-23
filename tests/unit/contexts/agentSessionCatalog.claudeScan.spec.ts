import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeClaudeProjectPath } from '../../../src/contexts/agent/infrastructure/ClaudeProjectPaths'
import { listAgentSessions } from '../../../src/contexts/agent/infrastructure/cli/AgentSessionCatalog'
import { clearAgentSessionCatalogCache } from '../../../src/contexts/agent/infrastructure/cli/AgentSessionCatalog.singleFlight'
import { clearSessionFileCache } from '../../../src/contexts/agent/infrastructure/cli/AgentSessionCatalog.cache'

const temporaryRoots: string[] = []

interface ClaudeFixture {
  cwd: string
  projectDir: string
  sessionIds: string[]
}

async function createClaudeFixture(transcriptCount: number): Promise<ClaudeFixture> {
  const root = await fs.mkdtemp(join(tmpdir(), 'opencove-claude-scan-'))
  temporaryRoots.push(root)

  const home = join(root, 'home')
  const configDir = join(root, 'claude')
  const cwd = join(root, 'workspace')
  const projectDir = join(configDir, 'projects', encodeClaudeProjectPath(cwd))

  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(projectDir, { recursive: true })

  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)

  const sessionIds: string[] = []
  const baseMtimeMs = Date.UTC(2026, 0, 1, 0, 0, 0)

  for (let index = 0; index < transcriptCount; index += 1) {
    const sessionId = `session-${String(index).padStart(4, '0')}`
    const filePath = join(projectDir, `${sessionId}.jsonl`)
    sessionIds.push(sessionId)

    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(
      filePath,
      `${JSON.stringify({ type: 'user', content: `Question ${index}` })}\n`,
      'utf8',
    )

    const timestamp = new Date(baseMtimeMs + index * 60_000)
    // eslint-disable-next-line no-await-in-loop
    await fs.utimes(filePath, timestamp, timestamp)
  }

  return { cwd, projectDir, sessionIds }
}

function openedTranscriptPaths(openSpy: { mock: { calls: unknown[][] } }): string[] {
  return openSpy.mock.calls
    .map(call => String(call[0]))
    .filter(filePath => filePath.endsWith('.jsonl'))
}

describe('Claude session scan bounds', () => {
  beforeEach(() => {
    clearSessionFileCache()
    clearAgentSessionCatalogCache()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await Promise.all(
      temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })),
    )
  })

  it('opens only the newest transcripts requested by the limit', async () => {
    const { cwd, sessionIds } = await createClaudeFixture(400)
    const openSpy = vi.spyOn(fs, 'open')

    const result = await listAgentSessions({ provider: 'claude-code', cwd, limit: 20 })

    const opened = openedTranscriptPaths(openSpy)
    const expectedNewestIds = sessionIds.slice(-20).reverse()

    expect(result.sessions.map(session => session.sessionId)).toEqual(expectedNewestIds)
    expect(opened).toHaveLength(20)
    expect(new Set(opened).size).toBe(20)
    expect(opened.map(filePath => basename(filePath, '.jsonl')).sort()).toEqual(
      [...expectedNewestIds].sort(),
    )
  })

  it('coalesces concurrent scans and reuses the completed result briefly', async () => {
    const { cwd } = await createClaudeFixture(60)
    const actualOpen = fs.open.bind(fs)
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 5))
      return await actualOpen(...args)
    })

    const [first, second] = await Promise.all([
      listAgentSessions({ provider: 'claude-code', cwd, limit: 20 }),
      listAgentSessions({ provider: 'claude-code', cwd, limit: 20 }),
    ])

    expect(first).toEqual(second)
    expect(openedTranscriptPaths(openSpy)).toHaveLength(20)
    expect(new Set(openedTranscriptPaths(openSpy)).size).toBe(20)

    await listAgentSessions({ provider: 'claude-code', cwd, limit: 20 })
    expect(openedTranscriptPaths(openSpy)).toHaveLength(20)
  })

  it('does not open any transcript when sessions-index.json is valid', async () => {
    const { cwd, projectDir } = await createClaudeFixture(40)
    await fs.writeFile(
      join(projectDir, 'sessions-index.json'),
      JSON.stringify({
        entries: [
          {
            sessionId: 'indexed-newer',
            projectPath: cwd,
            firstPrompt: 'Newest indexed session',
            modified: '2026-05-02T10:00:00.000Z',
          },
          {
            sessionId: 'indexed-older',
            projectPath: cwd,
            firstPrompt: 'Older indexed session',
            modified: '2026-05-01T10:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const openSpy = vi.spyOn(fs, 'open')

    const result = await listAgentSessions({ provider: 'claude-code', cwd, limit: 20 })

    expect(result.sessions.map(session => session.sessionId)).toEqual([
      'indexed-newer',
      'indexed-older',
    ])
    expect(result.sessions.every(session => session.source === 'claude-index')).toBe(true)
    expect(openedTranscriptPaths(openSpy)).toEqual([])
  })
})
