import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { cli, type LaunchedApp } from './orchestration.real-codex.helpers'
import { appServerRowsUnder, createLink, pidsGone } from './orchestration.hooks.real-codex.helpers'
import { nodeSessionId, processAlive } from './orchestration.real-codex.service.helpers'
import { seedWorkspaceState } from './workspace-canvas.helpers'

// E-07 helpers: the approval scenario runs with the personal Codex profile (Q2) and the scripted
// fake Responses API. Nothing here writes under ~/.codex; the app-server and the executor TUI are
// the product's own processes. The approval itself is answered on the executor TUI, the phase 2
// human path, while the card, the system notification and the sound are read from the test records.

export const approvalWorkspaceId = 'orch-approval'
export const approvalOrchestratorNodeId = 'approval-orchestrator'
export const approvalExecutorNodeId = 'approval-executor'
export const approvalExecutorTitle = 'approval-executor'

export { appServerRowsUnder, createLink, nodeSessionId, pidsGone }

const directory = (workspace: string) => ({
  executionDirectory: workspace,
  expectedDirectory: workspace,
  directoryMode: 'workspace' as const,
  customDirectory: null,
  shouldCreateDirectory: false,
})

/** Seeds the orchestrator stub and the executor; the user CLI links them. Full access is off. */
export async function seedApprovalWorkspace(window: Page, workspace: string): Promise<void> {
  const location = directory(workspace)
  await seedWorkspaceState(window, {
    activeWorkspaceId: approvalWorkspaceId,
    settings: {
      defaultProvider: 'claude-code',
      agentFullAccess: false,
      customModelEnabledByProvider: { codex: false },
      // The three attention channels the approval must reach.
      standbyBannerEnabled: true,
      standbyBannerShowBranch: false,
      standbyBannerShowPullRequest: false,
      systemNotificationsEnabled: true,
      notificationSoundEnabled: true,
      notificationSound: 'bit',
      notificationSoundVolume: 40,
    },
    workspaces: [
      {
        id: approvalWorkspaceId,
        name: 'Orchestration approval',
        path: workspace,
        nodes: [
          {
            id: approvalOrchestratorNodeId,
            title: 'Orchestrator stub',
            kind: 'agent',
            status: null,
            startedAt: null,
            endedAt: null,
            exitCode: null,
            lastError: null,
            position: { x: 640, y: 80 },
            width: 460,
            height: 300,
            ...location,
            agent: {
              provider: 'claude-code',
              prompt: 'Orchestrator stub; the user CLI drives the executor.',
              model: null,
              effectiveModel: null,
              launchMode: 'new',
              resumeSessionId: null,
              ...location,
            },
          },
          {
            id: approvalExecutorNodeId,
            title: approvalExecutorTitle,
            kind: 'agent',
            status: null,
            startedAt: null,
            endedAt: null,
            exitCode: null,
            lastError: null,
            position: { x: 100, y: 80 },
            width: 460,
            height: 300,
            ...location,
            agent: {
              provider: 'codex',
              prompt: 'Executor driven by the user CLI.',
              model: null,
              effectiveModel: null,
              launchMode: 'new',
              resumeSessionId: null,
              ...location,
            },
          },
        ],
        spaces: [],
      },
    ],
  })
}

export interface ApprovalStatus {
  health: string
  pendingApprovals: number
  lastState: string
  lastOutcome: string | null
}

/** One link from `orch status -o json`, or null while it is absent. */
export async function readApprovalStatus(userDataDir: string): Promise<ApprovalStatus | null> {
  const result = await cli(userDataDir, [
    'orch',
    'status',
    '--to',
    approvalExecutorNodeId,
    '-o',
    'json',
  ])
  if (result.exitCode !== 0) {
    return null
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      links?: Array<{
        health?: string
        pendingApprovals?: number
        last?: { state?: string; outcome?: string | null } | null
      }>
    }
    const link = parsed.links?.[0]
    if (!link) {
      return null
    }
    return {
      health: link.health ?? '',
      pendingApprovals: link.pendingApprovals ?? 0,
      lastState: link.last?.state ?? '',
      lastOutcome: link.last?.outcome ?? null,
    }
  } catch {
    return null
  }
}

export async function dispatchApprovalTurn(
  userDataDir: string,
  text: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await cli(userDataDir, [
    'orch',
    'dispatch',
    '--to',
    approvalExecutorNodeId,
    '--text',
    text,
  ])
}

export interface ExecutorRunState {
  state: string
  blockedReason: string | null
  turnOutcome: string | null
}

/** The run state of the executor session, as the renderer and the sidebar read it. */
export async function readExecutorRunState(
  window: Page,
  sessionId: string,
): Promise<ExecutorRunState | null> {
  return await window.evaluate(
    async id =>
      await window.opencoveApi.controlSurface.invoke<ExecutorRunState | null>({
        kind: 'query',
        id: 'agent.get',
        payload: { sessionId: id },
      }),
    sessionId,
  )
}

export function executorTerminal(window: Page, nodeId: string): Locator {
  return window.locator(`[data-id="${nodeId}"] .xterm-rows`)
}

// Renderer and main test records already used by workspace-canvas.agent-attention-routing.spec.ts.
const SYSTEM_HARNESS = '__opencoveSystemNotificationTestState'
const SOUND_LOG = '__opencoveNotificationSoundTestLog'

export interface RecordedSystemNotification {
  id: string | null
  title: string
  body: string | null
  silent: boolean
}

export async function pretendForeground(
  electronApp: ElectronApplication,
  foreground: boolean,
): Promise<void> {
  await electronApp.evaluate(
    (_electron, { value, read }) => {
      const scope = globalThis as unknown as Record<string, { foreground: boolean | null }>
      scope[read].foreground = value
    },
    { value: foreground, read: SYSTEM_HARNESS },
  )
}

export async function readShownNotifications(
  electronApp: ElectronApplication,
): Promise<RecordedSystemNotification[]> {
  return await electronApp.evaluate(
    (_electron, read) =>
      (globalThis as unknown as Record<string, { shown: RecordedSystemNotification[] }>)[read]
        .shown,
    SYSTEM_HARNESS,
  )
}

export async function readSoundLog(
  window: Page,
): Promise<Array<{ sound: string; volume: number }>> {
  return await window.evaluate(
    read =>
      (window as unknown as Record<string, Array<{ sound: string; volume: number }> | undefined>)[
        read
      ] ?? [],
    SOUND_LOG,
  )
}

/** Closing an app with a pending approval can hang; never let afterEach eat the timeout. */
export async function closeLaunchedApp(app: LaunchedApp): Promise<void> {
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
  }
}
