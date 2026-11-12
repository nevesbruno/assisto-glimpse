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
import {
  appServerPidsUnder,
  parseDispatchId,
  pidsGone,
  processAlive,
  readDispatch,
  readLink,
  seedServiceWorkspace,
  serviceExecutorNodeId,
  serviceOrchestratorNodeId,
  serviceWorkspaceId,
  sleep,
} from './orchestration.real-codex.service.helpers'
import {
  cliThroughProxy,
  readWorkerConnection,
  startCliProxy,
  type CliProxy,
  type CliResult,
} from './orchestration.resend.real-codex.helpers'

// E-08: dispatches in flight and CLI timeouts (exit 124). The desktop credential drives the real
// CLI as a script outside the app, like E-03; the Codex executor is real and the model is the
// scripted fake Responses API of the fixture (zero cost). Admission and D5 are Worker plus CLI
// contract behavior, so no orchestrator model is needed to prove them.

const executorText = (seconds: number) => `EXEC_TASK alpha SLEEP=${seconds}`

interface BlockingDispatch {
  dispatchId: string
  state: string
  round: number
}

interface Admission {
  canDispatch: boolean
  reason: string | null
  blocking: BlockingDispatch | null
  willWait: boolean
}

interface DispatchAccepted {
  dispatchId: string
  state: string
  round: number
  roundsLimit: number
  duplicate: boolean
  admission: Admission
}

interface StatusLink {
  executorNodeId: string
  roundsUsed: number
  roundsLimit: number
  health: string
  admission: Admission
  current: { dispatchId: string; state: string; round: number } | null
}

interface CliErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
}

function acceptedOf(result: CliResult): DispatchAccepted {
  expect(result.exitCode, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as DispatchAccepted
}

function errorOf(result: CliResult): CliErrorBody {
  const line = result.stderr.split('\n').find(entry => entry.startsWith('{"error"'))
  if (!line) {
    throw new Error(`CLI error JSON not found in stderr: ${result.stderr}`)
  }
  return (JSON.parse(line) as { error: CliErrorBody }).error
}

async function statusLinkOf(app: LaunchedApp): Promise<StatusLink> {
  const result = await cli(app.userDataDir, ['orch', 'status', '-o', 'json'])
  expect(result.exitCode, result.stderr).toBe(0)
  const parsed = JSON.parse(result.stdout) as { links: StatusLink[] }
  const link = parsed.links.find(candidate => candidate.executorNodeId === serviceExecutorNodeId)
  expect(link, 'status entry for the Codex executor').toBeDefined()
  return link!
}

async function waitForState(app: LaunchedApp, dispatchId: string, state: string): Promise<void> {
  await expect
    .poll(async () => (await readDispatch(app.userDataDir, dispatchId))?.state ?? 'missing', {
      timeout: 120_000,
      message: `dispatch ${dispatchId} state ${state}`,
    })
    .toBe(state)
}

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

let fixture: RealCodexFixture | null = null
let app: LaunchedApp | null = null
let profileBefore: Record<string, string>
let knownServicePids: number[] = []
let proxies: CliProxy[] = []

test.describe('orchestration phase 2 resend with the real Codex service', () => {
  test.skip(!realCodexEnabled(), 'Requires OPENCOVE_TEST_REAL_CODEX=1')
  test.skip(process.platform === 'win32', 'Codex lifecycle hooks are not used on Windows')

  test.beforeEach(async () => {
    profileBefore = await hashProfileFiles(personalCodexHome())
    fixture = await createFixture()
    knownServicePids = []
    proxies = []
  })

  test.afterEach(async ({ browserName: _browserName }, testInfo) => {
    await Promise.all(proxies.map(proxy => proxy.close().catch(() => undefined)))
    proxies = []
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
    fixture = null
  })

  test('E-08 in-flight refusal, CLI timeout resends and duplicate after completion', async () => {
    test.setTimeout(480_000)
    const currentFixture = fixture!
    app = await launchRealCodexApp(currentFixture)
    const launched = app
    await seedServiceWorkspace(launched.window, currentFixture.workspace)
    await expect
      .poll(
        async () =>
          (await cli(launched.userDataDir, ['node', 'list', '--project', serviceWorkspaceId]))
            .exitCode,
        { timeout: 60_000, message: 'CLI control surface' },
      )
      .toBe(0)

    const created = await cli(launched.userDataDir, [
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
      .poll(async () => (await statusLinkOf(launched)).health, {
        timeout: 120_000,
        message: 'linked executor ready',
      })
      .toBe('ready')
    const link = await readLink(launched.userDataDir, serviceExecutorNodeId)
    expect(link?.state).toBe('active')
    expect(link?.service_pid).not.toBeNull()
    knownServicePids = await appServerPidsUnder(launched.pid)
    expect(knownServicePids, 'executor app-server under the app').toContain(link!.service_pid!)
    const connection = await readWorkerConnection(launched.userDataDir)

    const dispatch = async (text: string, extra: string[] = []) =>
      await cli(launched.userDataDir, [
        'orch',
        'dispatch',
        '--to',
        serviceExecutorNodeId,
        '--text',
        text,
        '-o',
        'json',
        ...extra,
      ])
    const turnStarts = (text: string) =>
      currentFixture.api
        .requests()
        .filter(
          request =>
            request.role === 'executor' && !request.resumed && request.userText.includes(text),
        ).length

    // --- In-flight refusal: the second dispatch never reaches the model. -----------------------
    const longTask = executorText(25)
    const first = acceptedOf(await dispatch(longTask))
    expect(first.duplicate).toBe(false)
    expect(first.round).toBe(1)
    expect(first.roundsLimit).toBe(3)
    expect(first.admission).toMatchObject({
      canDispatch: false,
      reason: 'dispatch_in_flight',
      blocking: { dispatchId: first.dispatchId, state: 'queued', round: 1 },
    })
    await waitForState(launched, first.dispatchId, 'sent')
    await expect
      .poll(() => turnStarts(longTask), { timeout: 60_000, message: 'first turn start' })
      .toBe(1)

    const refused = await dispatch(longTask)
    expect(refused.exitCode, refused.stderr).toBe(1)
    const refusedError = errorOf(refused)
    expect(refusedError.code).toBe('orch.dispatch_in_flight')
    expect(refusedError.details).toMatchObject({
      dispatchId: first.dispatchId,
      state: 'sent',
      round: 1,
    })
    const blockedWhileSent = await statusLinkOf(launched)
    expect(blockedWhileSent.admission).toMatchObject({
      canDispatch: false,
      reason: 'dispatch_in_flight',
      willWait: false,
      blocking: { dispatchId: first.dispatchId, state: 'sent', round: 1 },
    })
    expect(blockedWhileSent.current?.dispatchId).toBe(first.dispatchId)
    expect(turnStarts(longTask), 'refused dispatch started no turn').toBe(1)
    await waitForState(launched, first.dispatchId, 'completed')

    // --- Timeout whose first attempt never reached the Worker ---------------------------------
    const timeoutTask = executorText(21)
    const dropProxy = await startCliProxy(connection.endpoint, 'drop-request')
    proxies.push(dropProxy)
    const neverReached = await cliThroughProxy(launched.userDataDir, connection, dropProxy.url, [
      'orch',
      'dispatch',
      '--to',
      serviceExecutorNodeId,
      '--text',
      timeoutTask,
      '--timeout',
      '1500',
      '-o',
      'json',
    ])
    expect(neverReached.exitCode, neverReached.stderr).toBe(124)
    expect(errorOf(neverReached).code).toBe('transport.timeout')
    const timeoutId = parseDispatchId(neverReached.stderr)
    expect(dropProxy.received().length, 'CLI reached the proxy').toBe(1)
    await sleep(1_000)
    expect(await readDispatch(launched.userDataDir, timeoutId), 'dropped dispatch row').toBeNull()
    await dropProxy.close()
    proxies = proxies.filter(proxy => proxy !== dropProxy)
    const beforeResend = await statusLinkOf(launched)
    expect(beforeResend.roundsUsed).toBe(1)
    expect(beforeResend.admission.canDispatch).toBe(true)

    // --- Resend accepted while its own reply is lost -----------------------------------------
    // The same id printed by the timed-out attempt is accepted as a new dispatch (round 2): the
    // first attempt lost nothing because it never arrived. This resend then has its reply held,
    // which is the "first was accepted and the reply was lost" case.
    const holdProxy = await startCliProxy(connection.endpoint, 'hold-response')
    proxies.push(holdProxy)
    const lostReply = await cliThroughProxy(launched.userDataDir, connection, holdProxy.url, [
      'orch',
      'dispatch',
      '--to',
      serviceExecutorNodeId,
      '--text',
      timeoutTask,
      '--id',
      timeoutId,
      '--timeout',
      '1500',
      '-o',
      'json',
    ])
    expect(lostReply.exitCode, lostReply.stderr).toBe(124)
    expect(errorOf(lostReply).code).toBe('transport.timeout')
    expect(parseDispatchId(lostReply.stderr)).toBe(timeoutId)
    await expect
      .poll(async () => (await readDispatch(launched.userDataDir, timeoutId))?.state ?? 'missing', {
        timeout: 30_000,
        message: 'Worker accepted the timed-out dispatch',
      })
      .toBe('sent')
    const timeoutRow = await readDispatch(launched.userDataDir, timeoutId)
    expect(timeoutRow?.round).toBe(2)
    await expect.poll(() => turnStarts(timeoutTask), { timeout: 60_000 }).toBe(1)

    const retried = await dispatch(timeoutTask)
    expect(retried.exitCode, retried.stderr).toBe(1)
    const retriedError = errorOf(retried)
    expect(retriedError.code).toBe('orch.dispatch_in_flight')
    expect(retriedError.details).toMatchObject({
      dispatchId: timeoutId,
      state: 'sent',
      round: 2,
    })
    const blockedByLost = await statusLinkOf(launched)
    expect(blockedByLost.admission).toMatchObject({
      canDispatch: false,
      reason: 'dispatch_in_flight',
      blocking: { dispatchId: timeoutId, state: 'sent', round: 2 },
    })
    expect(blockedByLost.current?.dispatchId).toBe(timeoutId)
    expect(turnStarts(timeoutTask), 'retry started no second turn').toBe(1)
    await waitForState(launched, timeoutId, 'completed')
    await holdProxy.close()
    proxies = proxies.filter(proxy => proxy !== holdProxy)

    // --- Duplicate by id after completion: D5 returns the finished record ----------------------
    const duplicate = acceptedOf(await dispatch(timeoutTask, ['--id', timeoutId]))
    expect(duplicate).toMatchObject({
      dispatchId: timeoutId,
      duplicate: true,
      state: 'completed',
      round: 2,
      roundsLimit: 3,
    })
    expect(turnStarts(timeoutTask), 'duplicate started no turn').toBe(1)

    // --- Same text after completion is a new dispatch and consumes a round --------------------
    const fresh = acceptedOf(await dispatch(timeoutTask))
    expect(fresh).toMatchObject({ duplicate: false, round: 3, roundsLimit: 3, state: 'queued' })
    expect(fresh.dispatchId).not.toBe(timeoutId)
    await waitForState(launched, fresh.dispatchId, 'sent')
    await expect.poll(() => turnStarts(timeoutTask), { timeout: 60_000 }).toBe(2)
    await waitForState(launched, fresh.dispatchId, 'completed')
    expect((await statusLinkOf(launched)).roundsUsed).toBe(3)
  })
})
