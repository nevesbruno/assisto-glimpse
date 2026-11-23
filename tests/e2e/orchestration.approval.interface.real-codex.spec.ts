import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  approvalExecutorNodeId,
  approvalExecutorTitle,
  approvalOrchestratorNodeId,
  appServerRowsUnder,
  closeLaunchedApp,
  createLink,
  dispatchApprovalTurn,
  executorTerminal,
  nodeSessionId,
  pidsGone,
  readApprovalStatus,
  readExecutorRunState,
  seedApprovalWorkspace,
} from './orchestration.approval.real-codex.helpers'
import {
  approveFirstPendingApproval,
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

// E-08 (F3-03): the approval requested by the real Codex service is answered in the Glimpse
// approval window. No key reaches the executor TUI: the section counts the request, the window
// shows the same summary, and the turn finishes with the file written outside the workspace.

test.describe('orchestration approval answered in the Glimpse window', () => {
  test.skip(!realCodexEnabled(), 'Requires OPENCOVE_TEST_REAL_CODEX=1')
  test.skip(process.platform === 'win32', 'Codex lifecycle hooks are not used on Windows')

  let fixture: RealCodexFixture | null = null
  let app: LaunchedApp | null = null
  let profileBefore: Record<string, string>
  let servicePids: number[] = []

  test.beforeEach(async () => {
    profileBefore = await hashProfileFiles(personalCodexHome())
    fixture = await createFixture()
    servicePids = []
  })

  test.afterEach(async ({ browserName: _browserName }, testInfo) => {
    if (app) {
      servicePids = (await appServerRowsUnder(app.pid)).map(row => row.pid)
      await testInfo.attach('app-stderr', { body: app.stderr(), contentType: 'text/plain' })
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo
          .attach('failure-screen', {
            body: await app.window.screenshot().catch(() => Buffer.alloc(0)),
            contentType: 'image/png',
          })
          .catch(() => undefined)
      }
    }
    if (app) {
      await closeLaunchedApp(app)
    }
    await fixture?.dispose()
    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
    await expect
      .poll(() => pidsGone(servicePids), { timeout: 15_000, message: 'app-server pids' })
      .toBe(true)
    app = null
    fixture = null
    servicePids = []
  })

  test('E-08 the window answer completes the turn and runs the command outside the workspace', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(420_000)
    app = await launchRealCodexApp(fixture!, undefined, {
      OPENCOVE_TEST_ENABLE_SESSION_STATE_WATCHER: '1',
    })
    const { window } = app
    await seedApprovalWorkspace(window, fixture!.workspace)
    await expect(window.locator(`[data-id="${approvalExecutorNodeId}"]`)).toBeVisible({
      timeout: 30_000,
    })

    const created = await createLink(
      app.userDataDir,
      approvalOrchestratorNodeId,
      approvalExecutorNodeId,
    )
    expect(created.exitCode, created.raw).toBe(0)
    expect(created.linkId, created.raw).not.toBeNull()

    await expect
      .poll(async () => (await readApprovalStatus(app!.userDataDir))?.health, {
        timeout: 60_000,
        message: 'executor health',
      })
      .toBe('ready')
    const executorRows = executorTerminal(window, approvalExecutorNodeId)
    await expect(executorRows).toContainText('OpenAI Codex', { timeout: 60_000 })

    const outside = path.join(fixture!.root, 'approval-window-probe')
    const dispatched = await dispatchApprovalTurn(
      app.userDataDir,
      `EXEC_TASK approval OUTSIDE=${outside}`,
    )
    expect(dispatched.exitCode, dispatched.stderr).toBe(0)

    // 1) The Control Center section shows a pending count for this executor.
    const dialog = await openApprovalsWindow(window, approvalExecutorNodeId)
    await expect(dialog).toContainText(approvalExecutorTitle)
    await expect(dialog).toContainText(/touch|probe/i)

    // 2) The answer comes from the window, not from the TUI.
    const approvedTestId = await approveFirstPendingApproval(window)
    expect(approvedTestId).toContain('orchestration-approval-accept-')

    await expect
      .poll(async () => (await readApprovalStatus(app!.userDataDir))?.pendingApprovals, {
        timeout: 60_000,
        message: 'pending approvals after the window answer',
      })
      .toBe(0)
    await expect
      .poll(async () => (await readApprovalStatus(app!.userDataDir))?.lastState, {
        timeout: 120_000,
        message: 'turn completion',
      })
      .toBe('completed')
    expect((await readApprovalStatus(app.userDataDir))?.lastOutcome).toBe('completed')
    expect(existsSync(outside), 'approved command ran outside the workspace').toBe(true)

    const sessionId = await nodeSessionId(window, approvalExecutorNodeId)
    expect(sessionId, 'executor TUI session').toBeTruthy()
    await expect
      .poll(async () => (await readExecutorRunState(window, sessionId!))?.state, {
        timeout: 30_000,
        message: 'executor run state',
      })
      .toBe('idle')

    const evidence = {
      linkId: created.linkId,
      outside,
      approvedTestId,
      sessionId,
      status: await readApprovalStatus(app.userDataDir),
    }
    process.stdout.write(`[e08] ${JSON.stringify(evidence)}\n`)
    await testInfo.attach('approval-window-evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'text/plain',
    })

    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
  })
})
