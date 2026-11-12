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
  pretendForeground,
  readApprovalStatus,
  readExecutorRunState,
  readShownNotifications,
  readSoundLog,
  seedApprovalWorkspace,
} from './orchestration.approval.real-codex.helpers'
import {
  createFixture,
  hashProfileFiles,
  launchRealCodexApp,
  personalCodexHome,
  realCodexEnabled,
  type LaunchedApp,
  type RealCodexFixture,
} from './orchestration.real-codex.helpers'

// E-07: with full access off, the fake API routes a command outside the workspace and the real
// Codex service asks for approval. The user is called through the three attention channels (card,
// silent system notification, sound) while the app pretends to be in the background; the card
// click jumps to the executor node; answering the request on the executor TUI clears "needs you"
// and lets the turn finish. The personal profile is only executed (Q2): config.toml and hooks.json
// must hash the same before and after.

test.describe('orchestration approval with the real Codex service', () => {
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
      const screens = await app.window
        .locator('.xterm-rows')
        .allInnerTexts()
        .catch(() => [])
      await testInfo.attach('terminal-text', {
        body: screens.join('\n----\n'),
        contentType: 'text/plain',
      })
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

  test('E-07 the approval alert reaches the user and the TUI answer ends the turn', async ({
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

    // The system notification only appears when OpenCove is behind another app.
    await pretendForeground(app.electronApp, false)
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

    const outside = path.join(fixture!.root, 'approval-probe')
    const dispatched = await dispatchApprovalTurn(
      app.userDataDir,
      `EXEC_TASK approval OUTSIDE=${outside}`,
    )
    expect(dispatched.exitCode, dispatched.stderr).toBe(0)

    // 1) The approval card: executor name, the "needs approval" state and the request summary.
    const card = window.locator('[data-testid="app-notifications"] .app-notification')
    await expect(card).toHaveCount(1, { timeout: 150_000, message: 'approval card' })
    await expect(card).toContainText(approvalExecutorTitle)
    await expect(card).toContainText('Needs approval')
    await expect(card.getByTestId('app-notification-summary')).toContainText(/touch|probe/i)
    await expect(executorRows).toContainText('Yes, proceed', { timeout: 120_000 })
    const cardText = (await card.innerText()).replace(/\s+/g, ' ').trim().slice(0, 300)
    const tuiPrompt = (await executorRows.innerText())
      .split('\n')
      .filter(line => /Yes, proceed|Would you like/.test(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)

    // 2) The one sound and the silent system notification, recorded by the existing test doubles.
    await expect.poll(() => readSoundLog(window)).toEqual([{ sound: 'bit', volume: 40 }])
    await expect
      .poll(async () => (await readShownNotifications(app!.electronApp)).length, {
        message: 'system notifications',
      })
      .toBe(1)
    const [shown] = await readShownNotifications(app.electronApp)
    expect(shown).toMatchObject({ title: approvalExecutorTitle, silent: true })
    expect(shown?.body ?? '').toContain('Needs approval')

    // 3) The card click jumps to the executor node.
    await card.locator('.agent-island-card__main').click()
    const executorNode = window.locator(`.react-flow__node[data-id="${approvalExecutorNodeId}"]`)
    await expect(executorNode).toHaveAttribute('data-cove-navigation-focus', 'true', {
      timeout: 10_000,
    })
    const navigationFocus = await executorNode.getAttribute('data-cove-navigation-focus')
    await expect(window.getByTestId('app-notifications')).toHaveCount(0)

    // 4) The user answers on the executor TUI. The turn resumes and completes.
    const sessionId = await nodeSessionId(window, approvalExecutorNodeId)
    expect(sessionId, 'executor TUI session').toBeTruthy()
    await window.evaluate(async id => {
      await window.opencoveApi.pty.write({ sessionId: id, data: '\r' })
    }, sessionId!)
    await expect
      .poll(async () => (await readApprovalStatus(app!.userDataDir))?.pendingApprovals, {
        timeout: 60_000,
        message: 'pending approvals after the answer',
      })
      .toBe(0)
    await expect
      .poll(async () => (await readApprovalStatus(app!.userDataDir))?.lastState, {
        timeout: 120_000,
        message: 'turn completion',
      })
      .toBe('completed')
    expect((await readApprovalStatus(app.userDataDir))?.lastOutcome).toBe('completed')
    await expect
      .poll(async () => (await readExecutorRunState(window, sessionId!))?.state, {
        timeout: 30_000,
        message: 'executor run state',
      })
      .toBe('idle')
    expect(await readExecutorRunState(window, sessionId!)).toMatchObject({
      blockedReason: null,
      turnOutcome: 'completed',
    })
    expect(existsSync(outside), 'approved command ran outside the workspace').toBe(true)
    await expect(window.getByTestId('app-notifications')).toHaveCount(0)

    // The fake API answered the same conversation twice: the escalated tool call and its result.
    const executorRequests = fixture!.api.requests().filter(request => request.role === 'executor')
    expect(executorRequests.length).toBeGreaterThanOrEqual(2)
    expect(executorRequests.at(-1)?.resumed).toBe(true)

    const evidence = {
      linkId: created.linkId,
      outside,
      cardText,
      tuiPrompt,
      navigationFocus,
      sessionId,
      shown,
      sound: await readSoundLog(window),
      status: await readApprovalStatus(app.userDataDir),
      executorRequests: executorRequests.map(request => ({
        resumed: request.resumed,
        lastToolCommand: request.lastToolCommand,
      })),
    }
    process.stdout.write(`[e07] ${JSON.stringify(evidence)}\n`)
    await testInfo.attach('approval-evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'text/plain',
    })

    expect(await hashProfileFiles(personalCodexHome())).toEqual(profileBefore)
  })
})
