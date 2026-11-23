import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { cli } from './agent.prompt.real-codex.helpers'
import { createTestUserDataDir } from './workspace-canvas.testUtils'
import type { SeedNode } from './workspace-canvas.helpers'

const appPath = path.resolve(__dirname, '../../')
const stubScriptPath = path.resolve(__dirname, '../../scripts/test-agent-session-stub.mjs')

export const bootFailureMarker = 'orchestration boot step failed'
export const moduleErrorPattern =
  /require\(["']zod["']\)|Cannot find module|Unable to load preload script|module not found/i

export interface ObservedApp {
  electronApp: ElectronApplication
  window: Page
  userDataDir: string
  /** Everything the Electron main process and the Worker it forwards wrote to stderr since launch. */
  stderr: () => string
  /** Console errors and uncaught page errors of the renderer, collected from the first window. */
  rendererErrors: () => string[]
  close: () => Promise<void>
}

/**
 * Launches the built app like `launchApp`, but listens to stderr from the first byte: the Worker
 * logs its orchestration boot there, before `launchApp` hands the window back.
 */
export async function launchObservedApp(env: Record<string, string> = {}): Promise<ObservedApp> {
  const userDataDir = await createTestUserDataDir()
  const dirs = ['home', 'config', 'cache', 'runtime'].map(name => path.join(userDataDir, name))
  await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true, mode: 0o700 })))
  const [home, config, cache, runtime] = dirs
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== '__CFBundleIdentifier',
    ),
  )
  const electronApp = await electron.launch({
    timeout: 45_000,
    args: [appPath],
    env: {
      ...baseEnv,
      NODE_ENV: 'test',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_RUNTIME_DIR: runtime,
      OPENCOVE_TEST_WORKSPACE: appPath,
      OPENCOVE_TEST_USER_DATA_DIR: userDataDir,
      OPENCOVE_TEST_AGENT_STUB_SCRIPT: stubScriptPath,
      OPENCOVE_TEST_NODE_EXECUTABLE: process.execPath,
      OPENCOVE_TEST_CLAUDE_HOOK_INSTALL_FAILURE: '1',
      OPENCOVE_E2E_FORCE_RENDERER_SANDBOX: '1',
      OPENCOVE_E2E_WINDOW_MODE: process.env['OPENCOVE_E2E_WINDOW_MODE'] ?? 'offscreen',
      ...env,
    },
  })
  let stderr = ''
  electronApp.process().stderr?.on('data', chunk => {
    stderr += String(chunk)
  })
  const window = await electronApp.firstWindow()
  const rendererErrors: string[] = []
  window.on('pageerror', error => rendererErrors.push(`pageerror: ${error.message}`))
  window.on('console', message => {
    if (message.type() === 'error') {
      rendererErrors.push(`console.error: ${message.text()}`)
    }
  })
  await window.waitForLoadState('domcontentloaded')
  return {
    electronApp,
    window,
    userDataDir,
    stderr: () => stderr,
    rendererErrors: () => [...rendererErrors],
    close: async () => {
      await electronApp.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

/** The personal Codex profile, used to execute only; the smoke never writes there. */
export function personalCodexHome(): string {
  return process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex')
}

export async function hashProfileFiles(codexHome: string): Promise<Record<string, string>> {
  const names = ['config.toml', 'hooks.json']
  const hashes = await Promise.all(
    names.map(async name => {
      const content = await readFile(path.join(codexHome, name)).catch(() => null)
      return content ? createHash('sha256').update(content).digest('hex') : 'absent'
    }),
  )
  return Object.fromEntries(names.map((name, index) => [name, hashes[index]]))
}

export function agentNode(
  id: string,
  provider: 'claude-code' | 'codex',
  workspacePath: string,
  x: number,
): SeedNode {
  return {
    id,
    title: id,
    position: { x, y: 120 },
    width: 460,
    height: 300,
    kind: 'agent',
    status: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    lastError: null,
    executionDirectory: workspacePath,
    expectedDirectory: workspacePath,
    agent: {
      provider,
      prompt: 'Synthetic prompt prevents blank-session relaunch.',
      model: null,
      effectiveModel: null,
      launchMode: 'new',
      resumeSessionId: null,
      resumeSessionIdVerified: false,
      executionDirectory: workspacePath,
      expectedDirectory: workspacePath,
      directoryMode: 'workspace',
      customDirectory: null,
      shouldCreateDirectory: false,
    },
  }
}

export async function createLink(
  userDataDir: string,
  orchestratorNodeId: string,
  executorNodeId: string,
): Promise<{ exitCode: number; linkId: string | null; raw: string }> {
  const result = await cli(userDataDir, [
    'orch',
    'link',
    'create',
    '--orchestrator',
    orchestratorNodeId,
    '--executor',
    executorNodeId,
  ])
  const raw = `${result.stdout}\n${result.stderr}`
  const linkId =
    raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null
  return { exitCode: result.exitCode, linkId, raw }
}

export async function closeLink(userDataDir: string, linkId: string): Promise<void> {
  await cli(userDataDir, ['orch', 'link', 'close', '--link', linkId])
}
