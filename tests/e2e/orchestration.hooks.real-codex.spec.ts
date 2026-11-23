import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  appServerRowsUnder,
  approveHooks,
  closeLink,
  createHookScratch,
  createLink,
  dispatchTurn,
  hooksExecutorNodeId,
  hooksOrchestratorNodeId,
  hooksTaskText,
  listSessionHooks,
  pidsGone,
  preToolUseHook,
  readStatus,
  rewriteHookMarker,
  seedHooksWorkspace,
  type HookScratch,
  type ListedHook,
} from './orchestration.hooks.real-codex.helpers'
import {
  createFixture,
  hashProfileFiles,
  launchRealCodexApp,
  personalCodexHome,
  realCodexEnabled,
  type LaunchedApp,
  type RealCodexFixture,
} from './orchestration.real-codex.helpers'

// E-06: the personal Codex profile is executed, never written (Q2). The PreToolUse hook travels
// only as `-c` on the processes the fixture wrapper launches. Without approval the hook does not
// run; `orch.hooks.approve` restarts the service and the same turn then runs it; changing the hook
// invalidates the approval. config.toml and hooks.json must hash the same before and after.

test.describe('orchestration hooks with the real Codex service', () => {
  test.skip(!realCodexEnabled(), 'Requires OPENCOVE_TEST_REAL_CODEX=1')
  test.skip(process.platform === 'win32', 'Codex lifecycle hooks are not used on Windows')

  let fixture: RealCodexFixture | null = null
  let app: LaunchedApp | null = null
  let scratch: HookScratch | null = null
  let linkId: string | null = null
  let profileBefore: Record<string, string>
  let servicePids: number[] = []

  test.beforeEach(async () => {
    profileBefore = await hashProfileFiles(personalCodexHome())
  })

  test.afterEach(async ({ browserName: _browserName }, testInfo) => {
    if (app) {
      servicePids = (await appServerRowsUnder(app.pid)).map(row => row.pid)
    }
    await testInfo.attach('app-stderr', { body: app?.stderr() ?? '', contentType: 'text/plain' })
    await app?.electronApp.close().catch(() => undefined)
    await fixture?.dispose()
    await scratch?.dispose()
    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
    await expect
      .poll(() => pidsGone(servicePids), { timeout: 15_000, message: 'app-server pids' })
      .toBe(true)
    app = null
    fixture = null
    scratch = null
    linkId = null
    servicePids = []
  })

  test('E-06 approving the -c PreToolUse hook makes the same turn write the marker', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(420_000)
    scratch = await createHookScratch()
    fixture = await createFixture([preToolUseHook(scratch.marker)])
    // Read the hook key and hash through the same wrapper, before any service owns CODEX_HOME.
    const listed = await listSessionHooks({
      wrapperDir: fixture.wrapperDir,
      cwd: fixture.workspace,
    })
    const pending = listed.find(hook => hook.command?.includes(scratch!.marker))
    expect(pending, JSON.stringify(listed)).toBeDefined()
    expect(pending!.trustStatus).toBe('untrusted')
    const approvedHash = pending!.currentHash
    // The personal profile may carry its own untrusted hooks; the count must tolerate them.
    const pendingOf = (hooks: ListedHook[]) =>
      hooks.filter(hook => hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified')
        .length
    const pendingBefore = pendingOf(listed)
    expect(pendingBefore, 'our hook is pending').toBeGreaterThanOrEqual(1)
    app = await launchRealCodexApp(fixture)
    const { window } = app
    await seedHooksWorkspace(window, fixture.workspace)
    await expect(window.locator(`[data-id="${hooksExecutorNodeId}"]`)).toBeVisible({
      timeout: 30_000,
    })

    const created = await createLink(app.userDataDir, hooksOrchestratorNodeId, hooksExecutorNodeId)
    expect(created.exitCode, created.raw).toBe(0)
    linkId = created.linkId
    expect(linkId, created.raw).not.toBeNull()

    // The hook is on the launched app-server command line, not on any profile file.
    const serviceRows = await appServerRowsUnder(app.pid)
    expect(serviceRows.length).toBeGreaterThanOrEqual(1)
    expect(
      serviceRows.some(
        row => row.command.includes('hooks.PreToolUse=') && row.command.includes(scratch!.marker),
      ),
      serviceRows.map(row => row.command).join('\n'),
    ).toBe(true)
    const firstServicePid = serviceRows[0].pid

    const pendingHooks = async () =>
      (await readStatus(app!.userDataDir, hooksExecutorNodeId))?.pendingHooks ?? -1
    const lastState = async () =>
      (await readStatus(app!.userDataDir, hooksExecutorNodeId))?.last?.state ?? ''

    await expect.poll(pendingHooks, { timeout: 30_000 }).toBe(pendingBefore)

    // First turn with a tool: it runs, the untrusted hook stays pending and writes nothing.
    const first = await dispatchTurn(app.userDataDir, hooksTaskText)
    expect(first.exitCode, first.stderr).toBe(0)
    await expect.poll(lastState, { timeout: 90_000, message: 'first turn' }).toBe('completed')
    // The tool itself ran (the fake API got the shell output); only the hook was skipped.
    expect(
      fixture.api
        .requests()
        .some(
          request =>
            request.role === 'executor' &&
            request.lastToolCommand === 'echo hooked' &&
            request.lastToolOutput.includes('hooked'),
        ),
      JSON.stringify(fixture.api.requests().map(request => request.lastToolOutput)),
    ).toBe(true)
    expect(existsSync(scratch.marker), 'marker before approval').toBe(false)
    await expect.poll(pendingHooks, { timeout: 30_000 }).toBe(pendingBefore)

    const approved = await approveHooks(app.userDataDir, pending!.key)
    expect(approved.exitCode, approved.stderr).toBe(0)
    const approval = JSON.parse(approved.stdout) as { approved: number; restart: string }
    expect(approval.approved).toBe(1)
    expect(['done', 'scheduled']).toContain(approval.restart)
    await expect
      .poll(pendingHooks, { timeout: 60_000, message: 'pending hooks after approval' })
      .toBe(pendingBefore - 1)
    // The service restarted and the approval travels as `-c hooks.state`, never as a profile write.
    await expect
      .poll(
        async () => (await appServerRowsUnder(app!.pid)).some(row => row.pid !== firstServicePid),
        { timeout: 60_000, message: 'restarted app-server' },
      )
      .toBe(true)
    const restartedRow = (await appServerRowsUnder(app!.pid)).find(
      row => row.pid !== firstServicePid,
    )
    expect(restartedRow?.command).toContain('hooks.state=')
    expect(restartedRow?.command).toContain(approvedHash)
    expect(existsSync(scratch.marker), 'approval alone must not run the hook').toBe(false)

    // The same turn, after the service restart, now runs the approved hook.
    const second = await dispatchTurn(app.userDataDir, hooksTaskText)
    expect(second.exitCode, second.stderr).toBe(0)
    await expect.poll(lastState, { timeout: 90_000, message: 'second turn' }).toBe('completed')
    await expect.poll(() => existsSync(scratch!.marker), { timeout: 60_000 }).toBe(true)
    expect(await readFile(scratch.marker, 'utf8')).toContain('hit')
    await expect.poll(pendingHooks, { timeout: 30_000 }).toBe(pendingBefore - 1)

    // A changed hook keeps the same key and changes the hash, so the recorded approval no longer
    // matches: the new service lists it again and the same turn writes nothing.
    await rewriteHookMarker(fixture.wrapperDir, scratch.marker, scratch.markerAlt)
    const closed = await closeLink(app.userDataDir, linkId!)
    expect(closed.exitCode, closed.stderr).toBe(0)
    linkId = null
    await expect
      .poll(async () => await readStatus(app!.userDataDir), { timeout: 30_000 })
      .toBeNull()
    const alteredListed = await listSessionHooks({
      wrapperDir: fixture.wrapperDir,
      cwd: fixture.workspace,
    })
    const altered = alteredListed.find(hook => hook.command?.includes(scratch!.markerAlt))
    expect(altered, 'altered hook is listed').toBeDefined()
    expect(altered!.currentHash).not.toBe(approvedHash)
    const alteredPending = pendingOf(alteredListed)

    const recreated = await createLink(
      app.userDataDir,
      hooksOrchestratorNodeId,
      hooksExecutorNodeId,
    )
    expect(recreated.exitCode, recreated.raw).toBe(0)
    linkId = recreated.linkId
    expect(linkId, recreated.raw).not.toBeNull()
    await expect
      .poll(pendingHooks, { timeout: 60_000, message: 'altered hook pending again' })
      .toBe(alteredPending)

    const third = await dispatchTurn(app.userDataDir, hooksTaskText)
    expect(third.exitCode, third.stderr).toBe(0)
    await expect.poll(lastState, { timeout: 90_000, message: 'third turn' }).toBe('completed')
    expect(existsSync(scratch.markerAlt), 'altered hook must not run').toBe(false)

    const finalStatus = await readStatus(app.userDataDir)
    const evidence = {
      hookKey: pending!.key,
      approvedHash,
      alteredHash: altered!.currentHash,
      pendingBefore,
      pendingAfterApproval: pendingBefore - 1,
      alteredPending,
      restart: approval.restart,
      servicePidBefore: firstServicePid,
      servicePidAfter: restartedRow!.pid,
      serviceCommand: restartedRow!.command,
      marker: existsSync(scratch.marker) ? await readFile(scratch.marker, 'utf8') : null,
      finalStatus,
    }
    process.stdout.write(`[e06] ${JSON.stringify(evidence)}\n`)
    await testInfo.attach('hook-evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'text/plain',
    })
  })
})
