import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { collectProcessTree, parseProcessRows } from './agent.prompt.real-codex.daemon.processes'
import {
  createClaudeTestProfile,
  startClaudeOrchestratorApi,
  type ClaudeOrchestratorApi,
} from './orchestration.real-codex.claude'
import {
  cli,
  createFixture,
  hashProfileFiles,
  launchRealCodexApp,
  orchestratorNodeId,
  orchestratorSpaceId,
  personalCodexHome,
  realCodexEnabled,
  startOrchestrator,
  type LaunchedApp,
  type RealCodexFixture,
} from './orchestration.real-codex.helpers'

// Real Codex with the personal profile (Q2): the profile is only executed, never written. The
// model is the scripted fake Responses API of the fixture (zero model cost). E-02, E-03 and E-07
// live below the E-01 case; E-06 is in orchestration.hooks.real-codex.spec.ts.

const edges = '[data-testid^="rf__edge-orch-link-"]'
const executors = ['alpha', 'beta'] as const

interface ListedNode {
  id: string
  kind: string
  title: string
  spaceId: string | null
}

interface LinkList {
  links: Array<{
    executorNodeId: string
    state: string
    closeReason: string | null
  }>
}

/** Pids of `codex app-server` processes descending from the app root pid. */
async function appServerPidsUnder(rootPid: number): Promise<number[]> {
  const { stdout } = await exec('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,sess=,command='], {
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return collectProcessTree(parseProcessRows(stdout, true), rootPid)
    .filter(row => /\bapp-server\b.*--ws-token-sha256/.test(row.command))
    .map(row => row.pid)
}

async function pidsGone(pids: number[]): Promise<boolean> {
  if (pids.length === 0) {
    return true
  }
  const result = await exec('ps', ['-o', 'pid=,stat=', '-p', pids.join(',')]).catch(() => ({
    stdout: '',
  }))
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .every(line => /^\s*\d+\s+Z/.test(line))
}

const exec = promisify(execFile)

const jsonOf = <T>(text: string): T => JSON.parse(text) as T

interface CodexThreadRow {
  id: string
  name: string | null
  archived: number
  cwd: string
  createdAt: number
}

/** Newest `state_<n>.sqlite` of the profile; the number changes with Codex versions. */
async function codexStateDbPath(codexHome: string): Promise<string> {
  const entries = await readdir(codexHome).catch(() => [] as string[])
  const states = entries
    .map(name => ({ name, match: /^state_(\d+)\.sqlite$/.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
  const newest = states.at(-1)
  if (!newest) {
    throw new Error(`No Codex state DB under ${codexHome}`)
  }
  return path.join(codexHome, newest.name)
}

/** Threads the profile recorded for `cwd` since `sinceMs`; opens the DB read-only. */
async function readCodexThreads(
  codexHome: string,
  cwd: string,
  sinceMs: number,
): Promise<CodexThreadRow[]> {
  const db = new DatabaseSync(await codexStateDbPath(codexHome), { readOnly: true })
  try {
    return db
      .prepare(
        'select id, name, archived, cwd, created_at as createdAt from threads where cwd = ? and created_at >= ?',
      )
      .all(cwd, Math.floor(sinceMs / 1000)) as unknown as CodexThreadRow[]
  } finally {
    db.close()
  }
}

test.describe('orchestration phase 2 with the real Codex service', () => {
  test.skip(!realCodexEnabled(), 'Requires OPENCOVE_TEST_REAL_CODEX=1')
  test.skip(process.platform === 'win32', 'Codex lifecycle hooks are not used on Windows')

  let fixture: RealCodexFixture
  let app: LaunchedApp | null = null
  let claude: ClaudeOrchestratorApi | null = null
  let profileBefore: Record<string, string>
  let knownServicePids: number[] = []

  test.beforeEach(async () => {
    profileBefore = await hashProfileFiles(personalCodexHome())
    fixture = await createFixture()
    knownServicePids = []
  })

  test.afterEach(async ({ browserName: _browserName }, testInfo) => {
    await testInfo.attach('api-requests', {
      body: JSON.stringify(
        fixture.api.requests().map(r => ({ ...r, userText: r.userText.slice(0, 400) })),
        null,
        2,
      ),
      contentType: 'text/plain',
    })
    if (claude) {
      await testInfo.attach('claude-commands', {
        body: claude.commands().join('\n---\n'),
        contentType: 'text/plain',
      })
      await testInfo.attach('claude-results', {
        body: claude.results().join('\n---\n'),
        contentType: 'text/plain',
      })
      await new Promise<void>(done => claude!.server.close(() => done()))
      claude = null
    }
    if (app) {
      const screens = await app.window
        .locator('.xterm-rows')
        .allInnerTexts()
        .catch(() => [])
      await testInfo.attach('terminal-text', {
        body: screens.join('\n----\n'),
        contentType: 'text/plain',
      })
      await testInfo.attach('app-stderr', { body: app.stderr(), contentType: 'text/plain' })
      await app.electronApp.close().catch(() => undefined)
    }
    await fixture.dispose()
    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
    await expect
      .poll(() => pidsGone(knownServicePids), { timeout: 15_000, message: 'app-server pids' })
      .toBe(true)
    app = null
  })

  test('E-01 orchestrator drives two executors without a click after the mount', async () => {
    test.setTimeout(420_000)
    const since = Date.now()
    claude = await startClaudeOrchestratorApi()
    const claudeEnv = await createClaudeTestProfile(fixture.root, fixture.workspace, claude.url)
    app = await launchRealCodexApp(fixture, undefined, claudeEnv)
    const { window } = app
    const script = 'ORCH_SPAWN alpha:BARRIER beta:BARRIER'
    const orchestrator = await startOrchestrator(app, fixture, script, { fullAccess: true })
    expect(orchestrator.nodeId).toBe(orchestratorNodeId)
    // E-01: the Run click is the only pointer input; everything after it is CLI driven.
    await window.evaluate(() => {
      const state = window as Window & { __opencoveE2EClicks?: number }
      state.__opencoveE2EClicks = 0
      window.addEventListener(
        'pointerdown',
        () => {
          state.__opencoveE2EClicks = (state.__opencoveE2EClicks ?? 0) + 1
        },
        true,
      )
    })
    // With `skipDangerousModePermissionPrompt` the dialog should not appear; if this Claude version
    // still shows it, accept it (Down, Enter) on the orchestrator PTY.
    await expect
      .poll(
        async () => {
          if (claude!.turns().some(turn => turn.includes('ORCH_SPAWN'))) {
            return true
          }
          const screens = await window
            .locator('.xterm-rows')
            .allInnerTexts()
            .catch(() => [])
          if (screens.some(screen => screen.includes('Yes, I accept'))) {
            await window.evaluate(
              id =>
                window.opencoveApi.pty
                  .write({ sessionId: id, data: '\u001b[B\r' })
                  .catch(() => undefined),
              orchestrator.sessionId,
            )
          }
          return false
        },
        { timeout: 90_000, intervals: [1_500], message: 'Claude bypass acknowledgement' },
      )
      .toBe(true)

    await expect(window.locator(edges)).toHaveCount(2, { timeout: 90_000 })
    await expect
      .poll(async () => (knownServicePids = await appServerPidsUnder(app!.pid)).length, {
        timeout: 60_000,
        message: 'executor app-server pids',
      })
      .toBeGreaterThanOrEqual(2)

    const listed = await cli(app.userDataDir, ['node', 'list', '--project', 'orch-real'])
    expect(listed.exitCode, listed.stderr).toBe(0)
    const nodes = jsonOf<{ nodes: ListedNode[] }>(listed.stdout).nodes
    const spawned = nodes.filter(
      node => node.kind === 'agent' && executors.includes(node.title as (typeof executors)[number]),
    )
    expect(spawned.map(node => node.title).sort()).toEqual(['alpha', 'beta'])
    for (const node of spawned) {
      expect(node.spaceId, `space of executor ${node.title}`).toBe(orchestratorSpaceId)
    }
    const executorIds = Object.fromEntries(spawned.map(node => [node.title, node.id])) as Record<
      (typeof executors)[number],
      string
    >
    // `orch close --to` resolves an executor id, not the notice title; the orchestrator gets the ids
    // from `orch link list` in real use, and the e2e hands them to the scripted orchestrator.
    claude!.setCloseTargets(executorIds)

    await expect
      .poll(
        () =>
          claude!.turns().find(turn => turn.includes('[glimpse] 2 executores com novidade')) ?? '',
        { timeout: 180_000, message: 'aggregated notice with two lines' },
      )
      .not.toBe('')
    const notice = claude!
      .turns()
      .find(turn => turn.includes('[glimpse] 2 executores com novidade'))!
    const lines = notice.split('\n').filter(line => line.startsWith('- '))
    expect(lines).toHaveLength(2)
    for (const name of executors) {
      const line = lines.find(entry => entry.startsWith(`- ${name} (codex)`))
      expect(line, `notice line for ${name}`).toBeDefined()
      expect(line).toContain(`ler: opencove agent read --node ${name} --turn `)
    }

    await expect
      .poll(
        () =>
          executors.every(name =>
            claude!.commands().some(c => c.includes(`orch close --to "${executorIds[name]}"`)),
          ),
        { timeout: 120_000, message: 'both closes after the reads' },
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          claude!.results().filter(result => result.includes('desligado, conversa arquivada'))
            .length,
        { timeout: 120_000, message: 'two close outputs' },
      )
      .toBe(2)
    const commands = claude!.commands()
    const readIndex = (name: string) =>
      commands.findIndex(c => c.includes(`agent read --node ${name} --turn `))
    const closeIndex = (name: string) =>
      commands.findIndex(c => c.includes(`orch close --to "${executorIds[name]}"`))
    expect(Math.max(...executors.map(readIndex))).toBeGreaterThanOrEqual(0)
    expect(Math.min(...executors.map(closeIndex))).toBeGreaterThan(
      Math.max(...executors.map(readIndex)),
    )
    for (const name of executors) {
      expect(claude!.results().some(result => result.includes(`EXEC_DONE ${name}`))).toBe(true)
    }

    await expect(window.locator(edges)).toHaveCount(0, { timeout: 120_000 })

    // The links survive the close in the closed state, not deleted.
    const links = await cli(app.userDataDir, ['orch', 'link', 'list', '--project', 'orch-real'])
    expect(links.exitCode, links.stderr).toBe(0)
    const closed = jsonOf<LinkList>(links.stdout).links
    expect(closed.map(link => link.executorNodeId).sort()).toEqual(
      spawned.map(node => node.id).sort(),
    )
    for (const link of closed) {
      expect(link.state).toBe('closed')
      expect(link.closeReason).toBe('orchestrator')
    }

    const glimpseThreads = async () =>
      (await readCodexThreads(personalCodexHome(), fixture.workspace, since - 5_000)).filter(
        thread => thread.name?.startsWith('Glimpse: '),
      )
    await expect
      .poll(async () => (await glimpseThreads()).filter(thread => thread.archived === 1).length, {
        timeout: 30_000,
        message: 'archived Glimpse threads',
      })
      .toBe(2)
    const threads = await glimpseThreads()
    // R13/ADR say "Glimpse: título do nó"; the runtime names the thread with the executor node id
    // (CodexExecutorRuntime.startThread). The e2e pins the observable name and reports the gap.
    expect(threads.map(thread => thread.name).sort()).toEqual(
      spawned.map(node => `Glimpse: ${node.id}`).sort(),
    )
    for (const thread of threads) {
      expect(thread.cwd).toBe(fixture.workspace)
      expect(thread.archived).toBe(1)
    }

    const requests = fixture.api.requests()
    expect(
      new Set(requests.filter(request => request.role === 'executor').map(r => r.label)),
    ).toEqual(new Set(executors))
    expect(
      await window.evaluate(
        () => (window as Window & { __opencoveE2EClicks?: number }).__opencoveE2EClicks,
      ),
      'pointer clicks after Run',
    ).toBe(0)

    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
  })
})
