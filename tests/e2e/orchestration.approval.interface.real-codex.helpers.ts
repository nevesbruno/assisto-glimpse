import { expect, type Locator, type Page } from '@playwright/test'

/**
 * F3-03 helpers: the pending list is read only through the Glimpse window. No helper here writes
 * to a PTY or calls a CLI approval command; the window is the only answering surface.
 */

const WINDOW = '[data-testid="orchestration-approvals-window"]'

export async function openApprovalsWindow(
  window: Page,
  executorNodeId: string,
  expectedCount?: number,
): Promise<Locator> {
  await window.getByTestId('app-header-control-center').click()
  const count = window.getByTestId(`control-center-approvals-count-${executorNodeId}`)
  await expect(count).toBeVisible({ timeout: 60_000 })
  if (expectedCount !== undefined) {
    await expect(count).toHaveText(new RegExp(`\\b${expectedCount}\\b`))
  }
  await window.getByTestId(`control-center-approvals-open-${executorNodeId}`).click()
  const dialog = window.locator(WINDOW)
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

export async function approveFirstPendingApproval(window: Page): Promise<string> {
  const button = window.locator('[data-testid^="orchestration-approval-accept-"]').first()
  await expect(button).toBeVisible({ timeout: 30_000 })
  const testId = await button.getAttribute('data-testid')
  await button.click()
  await expect(button).toHaveCount(0, { timeout: 15_000 })
  return testId ?? ''
}

export async function approveHookInWindow(window: Page, key: string): Promise<void> {
  const row = window.locator(`[data-testid="orchestration-hook"][data-hook-key="${key}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByTestId('orchestration-hook-approve').click()
  await expect(row).toHaveCount(0, { timeout: 15_000 })
}

export async function closeApprovalsWindow(window: Page): Promise<void> {
  await window.getByTestId('orchestration-approvals-back').click()
  await expect(window.locator(WINDOW)).toHaveCount(0)
}
