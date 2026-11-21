import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  appServerRowsUnder,
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
  seedHooksWorkspace,
  type HookScratch,
  type ListedHook,
} from './orchestration.hooks.real-codex.helpers'
import {
  approveHookInWindow,
  openApprovalsWindow,
} from './orchestration.approval.interface.real-codex.helpers'
import {
  createFixture,
  hashProfileFiles,
  launchRealCodexApp,
  personalCodexHome,
  realCodexEnabled,
  type LaunchedApp,
  type RealCodexFixture,
} from './orchestration.real-codex.helpers'

// E-09 (F3-03): the PreToolUse hook waiting for trust is approved in the Glimpse window. The
// service restarts, the same turn then writes the marker, and the profile files hash the same
// before and after. The approval command never runs through the CLI.

test.describe('orchestration hooks approved in the Glimpse window', () => {
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

  test('E-09 the window approves the hook and the next turn writes the marker', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(420_000)
    scratch = await createHookScratch()
    fixture = await createFixture([preToolUseHook(scratch.marker)])
    const listed = await listSessionHooks({
      wrapperDir: fixture.wrapperDir,
      cwd: fixture.workspace,
    })
    const pending = listed.find(hook => hook.command?.includes(scratch!.marker))
    expect(pending, JSON.stringify(listed)).toBeDefined()
    expect(pending!.trustStatus).toBe('untrusted')
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

    const pendingHooks = async () =>
      (await readStatus(app!.userDataDir, hooksExecutorNodeId))?.pendingHooks ?? -1
    const lastState = async () =>
      (await readStatus(app!.userDataDir, hooksExecutorNodeId))?.last?.state ?? ''
    await expect.poll(pendingHooks, { timeout: 30_000 }).toBe(pendingBefore)

    // The untrusted hook does not run: the turn completes and the marker stays absent.
    const first = await dispatchTurn(app.userDataDir, hooksTaskText)
    expect(first.exitCode, first.stderr).toBe(0)
    await expect.poll(lastState, { timeout: 90_000, message: 'first turn' }).toBe('completed')
    expect(existsSync(scratch.marker), 'marker before approval').toBe(false)
    await expect.poll(pendingHooks, { timeout: 30_000 }).toBe(pendingBefore)
    const servicePidsBefore = (await appServerRowsUnder(app.pid)).map(row => row.pid)

    // The Approval window carries hooks and approvals in the same list; approve this key.
    const dialog = await openApprovalsWindow(window, hooksExecutorNodeId, pendingBefore)
    await expect(dialog).toContainText('PreToolUse')
    await approveHookInWindow(window, pending!.key)

    await expect
      .poll(pendingHooks, { timeout: 60_000, message: 'pending hooks after the window answer' })
      .toBe(pendingBefore - 1)
    await expect
      .poll(
        async () =>
          (await appServerRowsUnder(app!.pid)).some(row => !servicePidsBefore.includes(row.pid)),
        { timeout: 60_000, message: 'restarted service' },
      )
      .toBe(true)

    // The same turn now writes the marker; the approval survives as a `-c` override.
    const second = await dispatchTurn(app.userDataDir, hooksTaskText)
    expect(second.exitCode, second.stderr).toBe(0)
    await expect.poll(lastState, { timeout: 90_000, message: 'second turn' }).toBe('completed')
    await expect.poll(() => existsSync(scratch!.marker), { timeout: 60_000 }).toBe(true)
    expect(await readFile(scratch.marker, 'utf8')).toContain('hit')
    await expect.poll(pendingHooks, { timeout: 30_000 }).toBe(pendingBefore - 1)

    const finalStatus = await readStatus(app.userDataDir)
    const evidence = {
      hookKey: pending!.key,
      pendingBefore,
      pendingAfterWindowApproval: pendingBefore - 1,
      marker: await readFile(scratch.marker, 'utf8'),
      finalStatus,
    }
    process.stdout.write(`[e09] ${JSON.stringify(evidence)}\n`)
    await testInfo.attach('hook-window-evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'text/plain',
    })

    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
    const closed = linkId ? await closeLink(app.userDataDir, linkId) : null
    expect(closed?.exitCode ?? 0, closed?.stderr ?? '').toBe(0)
    linkId = null
  })
})
