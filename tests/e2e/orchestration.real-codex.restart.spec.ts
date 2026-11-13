import { expect, test, type TestInfo } from '@playwright/test'
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
  personalCodexHome,
  realCodexEnabled,
  startOrchestrator,
  type LaunchedApp,
  type RealCodexFixture,
  type RecordedRequest,
} from './orchestration.real-codex.helpers'
import {
  appServerPidsUnder,
  pidsGone,
  processAlive,
  readDispatches,
  readLink,
  readNoticesForDispatch,
  readOrchestratorBinding,
  readOrchestratorSnapshot,
  workerPidOf,
  type AgentSnapshot,
  type DispatchRow,
  type LinkRow,
  type NoticeRow,
} from './orchestration.real-codex.restart.helpers'

// E-02: the real Glimpse dies by SIGKILL while a Codex turn is running and reopens on the same
// data directory. The new Worker must reap the old app-server, resume the thread, settle the
// dispatch from the turn the service already holds, and deliver one notice for it without any
// orchestrator input (wave 6: resilient boot and an authoritative idle after the resume).

const executorTitle = 'alpha'

interface ListedNode {
  id: string
  kind: string
  title: string
}

interface RestartEvidence {
  userDataDir: string
  firstAppPid: number
  restartedPid: number
  oldWorkerPid: number
  oldServicePids: number[]
  newServicePids: number[]
  executorId: string
  before: DispatchRow
  after: DispatchRow
  linkBefore: LinkRow
  linkAfter: LinkRow
  notice: NoticeRow
  executorRequests: RecordedRequest[]
  executorTurnStarts: RecordedRequest[]
  orchestratorAfterRestart: AgentSnapshot
}

const jsonOf = <T>(text: string): T => JSON.parse(text) as T

/** Playwright's expect.poll proves the condition; this one also hands the value back. */
async function pollValue<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | null = null
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- bounded polling by design
    last = await read()
    if (last !== null) {
      return last
    }
    // eslint-disable-next-line no-await-in-loop -- bounded polling by design
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${message}: last value ${JSON.stringify(last)}`)
}

/** Closing the app on a crash-restarted profile can hang; never let afterEach eat the timeout. */
async function closeLaunchedApp(app: LaunchedApp): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    app.electronApp.close().catch(() => undefined),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, 20_000)
    }),
  ])
  if (timer !== undefined) {
    clearTimeout(timer)
  }
  if (processAlive(app.pid)) {
    try {
      process.kill(app.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}

test.describe('orchestration phase 2 with a real Glimpse restart', () => {
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
        fixture.api.requests().map(request => ({
          ...request,
          userText: request.userText.slice(0, 400),
        })),
        null,
        2,
      ),
      contentType: 'text/plain',
    })
    if (claude) {
      await testInfo.attach('claude-turns', {
        body: claude.turns().join('\n---\n'),
        contentType: 'text/plain',
      })
      await testInfo.attach('claude-commands', {
        body: claude.commands().join('\n---\n'),
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
      await closeLaunchedApp(app)
    }
    await fixture.dispose()
    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
    await expect
      .poll(() => pidsGone(knownServicePids), { timeout: 15_000, message: 'app-server pids' })
      .toBe(true)
    app = null
  })

  /** One full SIGKILL restart: spawn, crash the app and its Worker, restart, reconcile. */
  async function restartMidTurn(testInfo: TestInfo): Promise<RestartEvidence> {
    claude = await startClaudeOrchestratorApi()
    const claudeEnv = await createClaudeTestProfile(fixture.root, fixture.workspace, claude.url)
    app = await launchRealCodexApp(fixture, undefined, claudeEnv)
    const firstAppPid = app.pid
    const { window } = app
    const orchestrator = await startOrchestrator(
      app,
      fixture,
      `ORCH_SPAWN ${executorTitle}:SLEEP=120`,
      { fullAccess: true },
    )

    // Same bypass acknowledgement handling as E-01: the first Claude turn must reach the fake API.
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

    // The orchestrator node is resumable after the crash; its binding is written at launch.
    await expect
      .poll(async () => (await readOrchestratorBinding(window)).resumeSessionIdVerified, {
        timeout: 30_000,
        message: 'orchestrator resume binding',
      })
      .toBe(true)

    const executorRequests = () =>
      fixture.api.requests().filter(request => request.role === 'executor')
    // A turn start is the request without tool output; later requests continue that one turn.
    const executorTurnStarts = () => executorRequests().filter(request => !request.resumed)
    await expect
      .poll(() => executorTurnStarts().length, {
        timeout: 120_000,
        message: 'executor turn/start',
      })
      .toBe(1)
    expect(executorTurnStarts()[0]?.label).toBe(executorTitle)

    const listed = await cli(app.userDataDir, ['node', 'list', '--project', 'orch-real'])
    expect(listed.exitCode, listed.stderr).toBe(0)
    const executor = jsonOf<{ nodes: ListedNode[] }>(listed.stdout).nodes.find(
      node => node.kind === 'agent' && node.title === executorTitle,
    )
    expect(executor, `executor node ${executorTitle}`).toBeDefined()
    const executorId = executor!.id

    // The dispatch is `sent` and the turn is running before the crash.
    await expect
      .poll(async () => (await readDispatches(app!.userDataDir, executorId))?.[0]?.state ?? '', {
        timeout: 120_000,
        message: 'dispatch sent before the crash',
      })
      .toBe('sent')
    const beforeDispatches = await readDispatches(app.userDataDir, executorId)
    expect(beforeDispatches).toHaveLength(1)
    const before = beforeDispatches![0] as DispatchRow
    expect(before.turn_ref, 'turn ref before the crash').not.toBeNull()
    const linkBefore = (await readLink(app.userDataDir, executorId)) as LinkRow | null
    expect(linkBefore?.executor_session_ref, 'thread ref before the crash').not.toBeNull()
    expect(linkBefore?.service_pid, 'app-server pid before the crash').not.toBeNull()

    // The old app-server belongs to the app tree and is captured before the crash.
    await expect
      .poll(async () => (knownServicePids = await appServerPidsUnder(firstAppPid)).length, {
        timeout: 60_000,
        message: 'app-server pid before the crash',
      })
      .toBeGreaterThanOrEqual(1)
    const oldServicePids = [...knownServicePids]
    const oldWorkerPid = await workerPidOf(app.userDataDir)
    expect(oldWorkerPid, 'owned Worker pid').not.toBeNull()

    // Hard crash of the app and of the Worker it owns; only pids this test launched are touched.
    // The main dies first so it cannot respawn a Worker; the Worker dies before its one-second
    // parent watch can interrupt the turn or close the app-server. The next boot must reap the
    // orphan and resume the thread.
    const killed = app
    app = null
    process.kill(firstAppPid, 'SIGKILL')
    process.kill(oldWorkerPid!, 'SIGKILL')
    await expect
      .poll(() => processAlive(firstAppPid), { timeout: 15_000, message: 'app pid after SIGKILL' })
      .toBe(false)
    await expect
      .poll(() => processAlive(oldWorkerPid!), {
        timeout: 20_000,
        message: 'Worker pid after SIGKILL',
      })
      .toBe(false)

    // Restart on the very same data directory, with the same fake APIs and Claude profile.
    const waitForRestartService = async (restarted: LaunchedApp) =>
      await pollValue(
        async () => {
          const link = await readLink(restarted.userDataDir, executorId)
          const pids = await appServerPidsUnder(restarted.pid)
          knownServicePids = [...new Set([...knownServicePids, ...pids])]
          if (
            link?.service_pid !== null &&
            link?.service_pid !== linkBefore!.service_pid &&
            pids.includes(link.service_pid)
          ) {
            return { link, pids }
          }
          return null
        },
        90_000,
        'resumed app-server identity; the degraded boot must reconcile, never abort with orch.executor_unavailable',
      )

    // One relaunch only: the crash boot reconciles in degraded mode and retries by itself, so an
    // app-level retry would hide a regression instead of proving that the boot no longer aborts.
    const restarted = await launchRealCodexApp(fixture, killed.userDataDir, claudeEnv)
    app = restarted
    expect(restarted.userDataDir).toBe(killed.userDataDir)
    expect(restarted.pid).not.toBe(firstAppPid)
    const serviceAttempt = await waitForRestartService(restarted)
    const linkAfter = serviceAttempt.link
    const newServicePids = serviceAttempt.pids
    expect(newServicePids.length).toBeGreaterThanOrEqual(1)

    // Acceptance: every app-server pid of the dead app is gone after the relaunch.
    await expect
      .poll(() => pidsGone(oldServicePids), {
        timeout: 30_000,
        message: 'orphan app-server pids after the restart',
      })
      .toBe(true)

    // The turn is settled from the resumed thread, not by a second dispatch.
    await expect
      .poll(
        async () => (await readDispatches(restarted.userDataDir, executorId))?.[0]?.state ?? '',
        {
          timeout: 120_000,
          message: 'final dispatch state',
        },
      )
      .toMatch(/^(completed|failed)$/)
    const afterDispatches = await readDispatches(restarted.userDataDir, executorId)
    expect(afterDispatches).toHaveLength(1)
    const after = afterDispatches![0] as DispatchRow
    expect(after.id).toBe(before.id)
    expect(after.turn_ref).toBe(before.turn_ref)
    if (after.state === 'failed') {
      expect(['executor_down', 'interrupted', 'turn_failed']).toContain(after.reason)
    }

    // The link points at a new app-server under the restarted app, on the same thread.
    expect(linkAfter.executor_session_ref).toBe(linkBefore!.executor_session_ref)
    expect(linkAfter.state).toBe('active')
    expect(linkAfter.service_token_sha256).not.toBe(linkBefore!.service_token_sha256)
    expect(processAlive(linkAfter.service_pid!)).toBe(true)
    expect(await appServerPidsUnder(restarted.pid)).toContain(linkAfter.service_pid)

    // Exactly one notice for that dispatch; delivery is asserted by each case on its own.
    const noticeRows = await pollValue(
      async () => {
        const rows = await readNoticesForDispatch(restarted.userDataDir, before.id)
        return rows && rows.length > 0 ? rows : null
      },
      120_000,
      'notice row',
    )
    expect(noticeRows).toHaveLength(1)
    const notice = noticeRows![0] as NoticeRow
    expect(notice.dispatch_id).toBe(before.id)
    expect(['executor_down_in_turn', 'interrupted', 'failed_turn_failed', 'completed']).toContain(
      notice.kind,
    )

    // Evidence of the readiness gap: a resumed orchestrator reports unknown/degraded, no source.
    const orchestratorAfterRestart = await pollValue(
      async () => await readOrchestratorSnapshot(restarted.window),
      120_000,
      'orchestrator run state after restart',
    )

    // The fake Responses API saw exactly one turn/start for that dispatch; any additional request
    // is the same turn continuing after a tool output, never a second `turn/start`.
    expect(executorTurnStarts()).toHaveLength(1)
    expect(executorTurnStarts()[0]?.resumed).toBe(false)
    expect(
      executorRequests().every(request => request.userText.includes(`EXEC_TASK ${executorTitle}`)),
    ).toBe(true)

    await testInfo.attach('restart-proof', {
      body: JSON.stringify(
        {
          appPids: { first: firstAppPid, restarted: restarted.pid },
          oldServicePids,
          oldWorkerPid,
          newServicePids,
          link: { before: linkBefore, after: linkAfter },
          dispatch: { before, after },
          orchestratorAfterRestart,
          notices: noticeRows,
          executorApiRequests: executorRequests(),
        },
        null,
        2,
      ),
      contentType: 'text/plain',
    })

    return {
      userDataDir: restarted.userDataDir,
      firstAppPid,
      restartedPid: restarted.pid,
      oldWorkerPid: oldWorkerPid!,
      oldServicePids,
      newServicePids,
      executorId,
      before,
      after,
      linkBefore: linkBefore!,
      linkAfter,
      notice,
      executorRequests: executorRequests(),
      executorTurnStarts: executorTurnStarts(),
      orchestratorAfterRestart,
    }
  }

  test('E-02 SIGKILL mid-turn reaps the orphan and resumes the thread without input', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(300_000)
    const run = await restartMidTurn(testInfo)
    // Wave 6 R1/R2: the crash boot reconciles the run state and the pump reaches an authoritative
    // idle on its own, so the notice is delivered with no user turn to unblock it.
    await expect
      .poll(
        async () =>
          (await readNoticesForDispatch(run.userDataDir, run.before.id))?.[0]?.delivery_state ?? '',
        { timeout: 20_000, message: 'notice delivery without orchestrator input' },
      )
      .toBe('delivered')
  })

  // E-02 acceptance canary (wave 6): after the restart the resumed orchestrator reaches idle
  // without any input, so the outbox delivers the batch on the normal window.
  test('E-02 the notice is delivered after the restart without orchestrator input', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(300_000)
    const run = await restartMidTurn(testInfo)
    await expect
      .poll(
        async () =>
          (await readNoticesForDispatch(run.userDataDir, run.before.id))?.[0]?.delivery_state ?? '',
        { timeout: 20_000, message: 'notice delivery without input' },
      )
      .toBe('delivered')
  })
})
