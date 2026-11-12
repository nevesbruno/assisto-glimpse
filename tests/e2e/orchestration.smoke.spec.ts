import { expect, test } from '@playwright/test'
import {
  agentNode,
  bootFailureMarker,
  closeLink,
  createLink,
  hashProfileFiles,
  launchObservedApp,
  moduleErrorPattern,
  personalCodexHome,
} from './orchestration.smoke.helpers'
import { seedWorkspaceState, testWorkspacePath } from './workspace-canvas.helpers'

test.describe('Orchestration smoke (E-09)', () => {
  test('empty profile: window opens, preload loads and the Worker boots orchestration', async () => {
    test.setTimeout(120_000)
    const app = await launchObservedApp()
    try {
      const { window } = app
      await window.reload()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.locator('[data-testid="app-header-settings"]')).toBeVisible({
        timeout: 30_000,
      })
      expect(await window.evaluate(() => typeof window.opencoveApi)).toBe('object')

      // The query only answers once the Worker composed the orchestration service.
      const links = await window.evaluate(
        async () =>
          await window.opencoveApi.controlSurface.invoke({
            kind: 'query',
            id: 'orch.link.list',
            payload: {},
          }),
      )
      expect(links).toBeTruthy()

      expect(app.stderr()).not.toContain(bootFailureMarker)
      expect(app.stderr()).not.toMatch(moduleErrorPattern)
      expect(app.rendererErrors().filter(entry => moduleErrorPattern.test(entry))).toEqual([])
    } finally {
      await app.close()
    }
  })

  test('two agent nodes outside any space: orch link create draws the edge on the canvas', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.skip(
      process.env['OPENCOVE_TEST_REAL_CODEX'] !== '1',
      'Requires OPENCOVE_TEST_REAL_CODEX=1',
    )
    test.skip(process.platform === 'win32', 'Codex lifecycle hooks are not used on Windows')
    test.setTimeout(180_000)

    const codexHome = personalCodexHome()
    const profileBefore = await hashProfileFiles(codexHome)
    // The orchestrator is a stub-backed claude-code record: the real Claude never starts (O11).
    const app = await launchObservedApp({ CODEX_HOME: codexHome })
    const workspaceId = 'orch-smoke'
    const orchestratorId = 'smoke-orchestrator'
    const executorId = 'smoke-executor'
    let linkId: string | null = null
    try {
      const { window } = app
      await seedWorkspaceState(window, {
        activeWorkspaceId: workspaceId,
        workspaces: [
          {
            id: workspaceId,
            name: 'Orchestration smoke',
            path: testWorkspacePath,
            nodes: [
              agentNode(orchestratorId, 'claude-code', testWorkspacePath, 80),
              agentNode(executorId, 'codex', testWorkspacePath, 620),
            ],
            spaces: [],
          },
        ],
      })
      await expect(window.locator(`[data-id="${orchestratorId}"]`)).toBeVisible({ timeout: 30_000 })
      await expect(window.locator(`[data-id="${executorId}"]`)).toBeVisible({ timeout: 30_000 })

      const created = await createLink(app.userDataDir, orchestratorId, executorId)
      linkId = created.linkId
      expect(created.exitCode, created.raw).toBe(0)
      expect(linkId, created.raw).not.toBeNull()

      await expect(window.locator(`[data-testid="rf__edge-orch-link-${linkId}"]`)).toHaveCount(1, {
        timeout: 30_000,
      })
      expect(app.stderr()).not.toContain(bootFailureMarker)
    } finally {
      if (linkId) {
        await closeLink(app.userDataDir, linkId)
      }
      await testInfo.attach('app-stderr', { body: app.stderr(), contentType: 'text/plain' })
      await app.close()
      expect(await hashProfileFiles(codexHome)).toEqual(profileBefore)
    }
  })
})
