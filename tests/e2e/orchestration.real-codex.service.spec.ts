import { expect, test } from '@playwright/test'
import {
  cli,
  createFixture,
  hashProfileFiles,
  launchRealCodexApp,
  personalCodexHome,
  realCodexEnabled,
  type LaunchedApp,
  type RealCodexFixture,
} from './orchestration.real-codex.helpers'
/* oxlint-disable no-await-in-loop, no-unmodified-loop-condition -- the killer loop polls the pids and sleeps in order */
import {
  appServerPidsUnder,
  killAppServerUnder,
  nodeSessionId,
  parseDispatchId,
  pidsGone,
  processAlive,
  readDispatch,
  readLink,
  readNoticesForDispatch,
  readNoticesForExecutor,
  seedServiceWorkspace,
  serviceExecutorNodeId,
  serviceExecutorTitle,
  serviceOrchestratorNodeId,
  serviceWorkspaceId,
  sleep,
  type LinkRow,
} from './orchestration.real-codex.service.helpers'

// E-03: kill -9 on the real Codex app-server while the Worker keeps running. The supervisor
// restarts the service, the dispatch is reconciled after `executor.recovered`, and four deaths
// inside 60 s exhaust the 1/2/4 s backoff and leave the executor unavailable. The TUI relaunch
// case is a known defect (`handleExecutorIncident` does not call `relaunchExecutorTui`); it runs
// as an expected failure with the cause below and must be flipped when the wave 6 card lands.

interface StatusLink {
  title: string
  health: string
  roundsUsed: number
  admission: { canDispatch: boolean; reason: string | null }
  current: { dispatchId: string; createdAt: string } | null
}

interface StatusResult {
  links: StatusLink[]
}

const jsonOf = <T>(text: string): T => JSON.parse(text) as T

/** Closing an app whose TUI lost its service can hang; never let afterEach eat the timeout. */
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
    await sleep(1_000)
  }
}

async function statusOf(app: LaunchedApp): Promise<StatusResult | null> {
  const result = await cli(app.userDataDir, ['orch', 'status', '-o', 'json'])
  if (result.exitCode !== 0) {
    return null
  }
  try {
    return jsonOf<StatusResult>(result.stdout)
  } catch {
    return null
  }
}

async function statusLinkOf(app: LaunchedApp): Promise<StatusLink | null> {
  const status = await statusOf(app)
  return status?.links.find(link => link.title === serviceExecutorTitle) ?? null
}

/** Seeds the two nodes, links them through the user CLI and waits for the service to be ready. */
async function createServiceLink(app: LaunchedApp, workspace: string): Promise<number> {
  await seedServiceWorkspace(app.window, workspace)
  await expect
    .poll(
      async () =>
        (await cli(app.userDataDir, ['node', 'list', '--project', serviceWorkspaceId])).exitCode,
      { timeout: 60_000, message: 'CLI control surface' },
    )
    .toBe(0)
  const created = await cli(app.userDataDir, [
    'orch',
    'link',
    'create',
    '--orchestrator',
    serviceOrchestratorNodeId,
    '--executor',
    serviceExecutorNodeId,
  ])
  expect(created.exitCode, created.stderr).toBe(0)
  await expect
    .poll(async () => (await statusLinkOf(app))?.health ?? 'missing', {
      timeout: 120_000,
      message: 'linked executor ready',
    })
    .toBe('ready')
  const link = await readLink(app.userDataDir, serviceExecutorNodeId)
  expect(link?.state).toBe('active')
  expect(link?.service_pid).not.toBeNull()
  return link!.service_pid!
}

async function dispatchToExecutor(app: LaunchedApp, text: string): Promise<string> {
  const result = await cli(app.userDataDir, [
    'orch',
    'dispatch',
    '--to',
    serviceExecutorNodeId,
    '--text',
    text,
  ])
  expect(result.exitCode, result.stderr).toBe(0)
  return parseDispatchId(result.stderr)
}

async function waitForFinalDispatch(
  app: LaunchedApp,
  dispatchId: string,
  state: string,
  reason: string | null,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await readDispatch(app.userDataDir, dispatchId)
        return row === null ? 'missing' : `${row.state}:${row.reason ?? ''}`
      },
      { timeout: 120_000, message: `dispatch ${dispatchId} final state` },
    )
    .toBe(`${state}:${reason ?? ''}`)
}

async function waitForReplacementService(app: LaunchedApp, previousPid: number): Promise<number> {
  await expect
    .poll(
      async () => {
        const link = await readLink(app.userDataDir, serviceExecutorNodeId)
        if (!link?.service_pid || link.service_pid === previousPid) {
          return null
        }
        const pids = await appServerPidsUnder(app.pid)
        knownServicePids = [...new Set([...knownServicePids, ...pids])]
        return pids.includes(link.service_pid) ? link.service_pid : null
      },
      { timeout: 90_000, message: 'replacement app-server under the app' },
    )
    .not.toBeNull()
  const link = await readLink(app.userDataDir, serviceExecutorNodeId)
  return link!.service_pid!
}

async function noticeKinds(app: LaunchedApp, dispatchId: string): Promise<string[]> {
  return ((await readNoticesForDispatch(app.userDataDir, dispatchId)) ?? []).map(
    notice => notice.kind,
  )
}

async function expectNotice(app: LaunchedApp, dispatchId: string, kind: string): Promise<void> {
  await expect
    .poll(() => noticeKinds(app, dispatchId), {
      timeout: 60_000,
      message: `notice ${kind} of dispatch ${dispatchId}`,
    })
    .toContain(kind)
}

let fixture: RealCodexFixture
let app: LaunchedApp | null = null
let profileBefore: Record<string, string>
let knownServicePids: number[] = []

test.describe('orchestration phase 2 with real service deaths', () => {
  test.skip(!realCodexEnabled(), 'Requires OPENCOVE_TEST_REAL_CODEX=1')
  test.skip(process.platform === 'win32', 'Codex lifecycle hooks are not used on Windows')

  test.beforeEach(async () => {
    profileBefore = await hashProfileFiles(personalCodexHome())
    fixture = await createFixture()
    knownServicePids = []
  })

  test.afterEach(async ({ browserName: _browserName }, testInfo) => {
    if (fixture) {
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
    if (fixture) {
      await fixture.dispose()
    }
    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
    await expect
      .poll(() => pidsGone(knownServicePids), { timeout: 15_000, message: 'app-server pids' })
      .toBe(true)
    app = null
  })

  test('E-03 kill -9 mid-turn restarts the service, fails the dispatch with a down notice and keeps the link active', async () => {
    test.setTimeout(300_000)
    app = await launchRealCodexApp(fixture)
    const launched = app
    const servicePid = await createServiceLink(launched, fixture.workspace)
    const dispatchId = await dispatchToExecutor(
      launched,
      `EXEC_TASK ${serviceExecutorTitle} SLEEP=45`,
    )

    await expect
      .poll(async () => (await readDispatch(launched.userDataDir, dispatchId))?.state ?? '', {
        timeout: 120_000,
        message: 'dispatch sent before the kill',
      })
      .toBe('sent')
    const linkBefore = (await readLink(launched.userDataDir, serviceExecutorNodeId)) as LinkRow
    expect(linkBefore.service_pid).toBe(servicePid)
    expect(await appServerPidsUnder(launched.pid), 'service pid under the app').toContain(
      servicePid,
    )

    await killAppServerUnder(launched.pid, servicePid)
    const replacementPid = await waitForReplacementService(launched, servicePid)
    expect(replacementPid).not.toBe(servicePid)

    await waitForFinalDispatch(launched, dispatchId, 'failed', 'executor_down')
    await expectNotice(launched, dispatchId, 'executor_down_in_turn')
    const downNotices = (
      (await readNoticesForExecutor(launched.userDataDir, serviceExecutorNodeId)) ?? []
    ).filter(notice => notice.kind === 'executor_down')
    expect(downNotices.length).toBeGreaterThanOrEqual(1)

    const linkAfter = (await readLink(launched.userDataDir, serviceExecutorNodeId)) as LinkRow
    expect(linkAfter.state).toBe('active')
    expect(linkAfter.executor_session_ref).toBe(linkBefore.executor_session_ref)
    expect(linkAfter.service_token_sha256).not.toBe(linkBefore.service_token_sha256)
    expect(await appServerPidsUnder(launched.pid)).toContain(linkAfter.service_pid)
    await expect
      .poll(async () => (await statusLinkOf(launched))?.health ?? 'missing', {
        timeout: 60_000,
        message: 'recovered health',
      })
      .toBe('ready')
    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
  })

  test('E-03 after executor.recovered the TUI is relaunched on the same node (known defect)', async () => {
    test.setTimeout(240_000)
    app = await launchRealCodexApp(fixture)
    const launched = app
    const servicePid = await createServiceLink(launched, fixture.workspace)
    const sessionBefore = await nodeSessionId(launched.window, serviceExecutorNodeId)
    expect(sessionBefore, 'TUI session bound at link create').not.toBeNull()

    await killAppServerUnder(launched.pid, servicePid)
    await waitForReplacementService(launched, servicePid)
    await expect
      .poll(async () => (await statusLinkOf(launched))?.health ?? 'missing', {
        timeout: 60_000,
        message: 'executor.recovered observed through the status',
      })
      .toBe('ready')

    // Known defect (card of wave 6): handleExecutorIncident in reconcileOnBoot.ts only reconciles
    // the dispatch and records the service identity; it never calls relaunchExecutorTui, so the
    // node keeps the dead TUI session while the risk table says it is relaunched on the same node.
    test.fail()
    await expect
      .poll(
        async () => {
          const current = await nodeSessionId(launched.window, serviceExecutorNodeId)
          return current !== null && current !== sessionBefore
        },
        {
          timeout: 15_000,
          message: 'TUI session relaunched after executor.recovered',
        },
      )
      .toBe(true)
  })

  test('E-03 four deaths in 60 s leave the executor unavailable, fail the queued dispatch with not_sent and keep the link active', async () => {
    test.setTimeout(420_000)
    app = await launchRealCodexApp(fixture)
    const launched = app
    const firstPid = await createServiceLink(launched, fixture.workspace)

    // First death happens during a sent turn: the reconciliation after the restart settles it.
    const sentId = await dispatchToExecutor(launched, `EXEC_TASK ${serviceExecutorTitle} SLEEP=45`)
    await expect
      .poll(async () => (await readDispatch(launched.userDataDir, sentId))?.state ?? '', {
        timeout: 120_000,
        message: 'turn dispatched',
      })
      .toBe('sent')
    await killAppServerUnder(launched.pid, firstPid)
    const secondPid = await waitForReplacementService(launched, firstPid)
    await waitForFinalDispatch(launched, sentId, 'failed', 'executor_down')
    await expectNotice(launched, sentId, 'executor_down_in_turn')
    await expect
      .poll(async () => (await statusLinkOf(launched))?.health ?? 'missing', {
        timeout: 60_000,
        message: 'ready after the first restart',
      })
      .toBe('ready')

    // Second and third deaths while idle: the third restart gets the full 4 s backoff window,
    // where the next dispatch is accepted as `queued`. Every launch after it is killed before
    // readiness, so the supervisor exhausts the 1/2/4 s backoff with the dispatch still queued
    // (ADR: queued + unavailable -> failed(not_sent), refund).
    await killAppServerUnder(launched.pid, secondPid)
    const thirdPid = await waitForReplacementService(launched, secondPid)
    await expect
      .poll(async () => (await statusLinkOf(launched))?.health ?? 'missing', {
        timeout: 60_000,
        message: 'ready before the third death',
      })
      .toBe('ready')
    await killAppServerUnder(launched.pid, thirdPid)
    const killed = new Set<number>([firstPid, secondPid, thirdPid])
    let stopKiller = false
    const killer = (async () => {
      while (!stopKiller) {
        const pids = await appServerPidsUnder(launched.pid).catch(() => [] as number[])
        for (const pid of pids) {
          if (killed.has(pid)) {
            continue
          }
          killed.add(pid)
          knownServicePids = [...new Set([...knownServicePids, pid])]
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // The attempt already died.
          }
        }
        await sleep(50)
      }
    })()
    try {
      const queuedId = await dispatchToExecutor(
        launched,
        `EXEC_TASK ${serviceExecutorTitle} SLEEP=45`,
      )
      await expect
        .poll(async () => (await readDispatch(launched.userDataDir, queuedId))?.state ?? '', {
          timeout: 30_000,
          message: 'dispatch queued during the backoff',
        })
        .toBe('queued')
      await expect
        .poll(async () => (await statusLinkOf(launched))?.health ?? 'missing', {
          timeout: 90_000,
          intervals: [500],
          message: 'executor unavailable after four restart cycles',
        })
        .toBe('unavailable')

      const status = await statusOf(launched)
      const link = status?.links.find(candidate => candidate.title === serviceExecutorTitle)
      expect(link?.health).toBe('unavailable')
      expect(link?.admission).toMatchObject({
        canDispatch: false,
        reason: 'executor_unavailable',
      })

      await waitForFinalDispatch(launched, queuedId, 'failed', 'not_sent')
      await expectNotice(launched, queuedId, 'failed_not_sent')
      const linkAfter = (await readLink(launched.userDataDir, serviceExecutorNodeId)) as LinkRow
      expect(linkAfter.state).toBe('active')
      expect(linkAfter.rounds_used).toBe(1)
      expect(linkAfter.rounds_limit).toBe(3)

      const refused = await cli(launched.userDataDir, [
        'orch',
        'dispatch',
        '--to',
        serviceExecutorNodeId,
        '--text',
        `EXEC_TASK ${serviceExecutorTitle}`,
      ])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain('executor_unavailable')
      expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
    } finally {
      stopKiller = true
      await killer
    }
  })
})
