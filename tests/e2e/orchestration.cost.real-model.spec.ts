import { expect, test, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appServerPidsUnder,
  buildCostReport,
  createCostFixture,
  launchCostApp,
  startCostOrchestratorApi,
  type CostExecutor,
  type CostMode,
  type CostOrchestratorApi,
  type CostReport,
} from './orchestration.cost.real-model.helpers'
import { createClaudeTestProfile } from './orchestration.real-codex.claude'
import {
  orchestratorNodeId,
  startOrchestrator,
  type LaunchedApp,
} from './orchestration.real-codex.helpers'
import { cli } from './agent.prompt.real-codex.helpers'
import { hashProfileFiles, personalCodexHome } from './orchestration.smoke.helpers'

// E-04: one orchestrator, two executors, three short dispatches and the per-turn token truth from
// the Codex rollout JSONL. The orchestrator is scripted over the fake Messages API (zero cost);
// only the executors reach a real model, and only when OPENCOVE_TEST_REAL_MODEL=1 is set. The fake
// case is the rehearsal: same orchestration, deterministic Responses usage, no model cost.

const realModelEnabled = (): boolean => process.env['OPENCOVE_TEST_REAL_MODEL'] === '1'

const edges = '[data-testid^="rf__edge-orch-link-"]'
const exec = promisify(execFile)

interface ListedNode {
  id: string
  kind: string
  title: string
}

interface LinkList {
  links: Array<{ executorNodeId: string }>
}

async function resolveExecutorIds(app: LaunchedApp): Promise<Record<CostExecutor, string>> {
  const listed = await cli(app.userDataDir, ['node', 'list', '--project', 'orch-real'])
  expect(listed.exitCode, listed.stderr).toBe(0)
  const nodes = (JSON.parse(listed.stdout) as { nodes: ListedNode[] }).nodes
  const byTitle = (title: string) =>
    nodes.find(node => node.kind === 'agent' && node.title === title)
  const alpha = byTitle('alpha')
  const beta = byTitle('beta')
  expect(alpha?.id, 'alpha node').toBeTruthy()
  expect(beta?.id, 'beta node').toBeTruthy()
  const links = await cli(app.userDataDir, ['orch', 'link', 'list', '--project', 'orch-real'])
  expect(links.exitCode, links.stderr).toBe(0)
  const linked = (JSON.parse(links.stdout) as LinkList).links.map(link => link.executorNodeId)
  expect(linked.sort()).toEqual([alpha!.id, beta!.id].sort())
  return { alpha: alpha!.id, beta: beta!.id }
}

async function pidsGone(pids: number[]): Promise<boolean> {
  if (pids.length === 0) {
    return true
  }
  const result = await exec('ps', ['-o', 'pid=,stat=', '-p', pids.join(',')]).catch(() => ({
    stdout: '',
  }))
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .every(line => /^\s*\d+\s+Z/.test(line))
}

interface RunResult {
  report: CostReport
  orchestrator: string
}

async function runE04(input: {
  mode: CostMode
  app: LaunchedApp
  fixture: Awaited<ReturnType<typeof createCostFixture>>
  claude: CostOrchestratorApi
  sinceMs: number
  timeoutMs: number
}): Promise<RunResult> {
  const { app, claude } = input
  const orchestrator = await startOrchestrator(app, input.fixture, `E04_COST ${input.mode}`, {
    fullAccess: true,
  })
  expect(orchestrator.nodeId).toBe(orchestratorNodeId)
  await expect(app.window.locator(edges)).toHaveCount(2, {
    timeout: input.timeoutMs,
  })
  const executorIds = await resolveExecutorIds(app)
  claude.setExecutorIds(executorIds)
  const servicePids = await appServerPidsUnder(app.pid)
  await expect
    .poll(
      () =>
        claude.results().filter(result => result.includes('desligado, conversa arquivada')).length,
      { timeout: input.timeoutMs, message: 'two link closes' },
    )
    .toBe(2)
  await expect
    .poll(async () => pidsGone(await appServerPidsUnder(app.pid)), {
      timeout: 60_000,
      message: 'app-server pids after close',
    })
    .toBe(true)
  const report = await buildCostReport({
    mode: input.mode,
    codexHome: personalCodexHome(),
    workspace: input.fixture.workspace,
    sinceMs: input.sinceMs,
    notices: claude.notices(),
    executorIds,
  })
  // The report is the evidence line the harness greps from the runner log.
  // eslint-disable-next-line no-console
  console.log(`E04_COST_REPORT ${JSON.stringify({ ...report, servicePids })}`)
  return { report, orchestrator: orchestrator.sessionId }
}

function expectHarness(report: CostReport): void {
  expect(report.dispatches, 'dispatch count').toBe(3)
  expect(report.turns.filter(turn => turn.executor === 'alpha')).toHaveLength(2)
  expect(report.turns.filter(turn => turn.executor === 'beta')).toHaveLength(1)
  expect(report.notices.length, 'delivered notices').toBeGreaterThanOrEqual(2)
  expect(report.notices.reduce((sum, notice) => sum + notice.lines, 0)).toBeGreaterThanOrEqual(3)
  for (const turn of report.turns) {
    expect(turn.requests, `requests of ${turn.prompt}`).toBeGreaterThanOrEqual(1)
  }
}

async function attachEvidence(
  testInfo: TestInfo,
  app: LaunchedApp,
  report: CostReport,
): Promise<void> {
  await testInfo.attach('e04-cost-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('app-stderr', { body: app.stderr(), contentType: 'text/plain' })
}

async function runScenario(mode: CostMode, testInfo: TestInfo): Promise<void> {
  const timeoutMs = mode === 'real' ? 600_000 : 240_000
  const profileBefore = await hashProfileFiles(personalCodexHome())
  const fixture = await createCostFixture(mode)
  const claude = await startCostOrchestratorApi()
  const claudeEnv = await createClaudeTestProfile(fixture.root, fixture.workspace, claude.url)
  const sinceMs = Date.now()
  const app = await launchCostApp(fixture, undefined, claudeEnv)
  try {
    const { report } = await runE04({
      mode,
      app,
      fixture,
      claude,
      sinceMs,
      timeoutMs,
    })
    await attachEvidence(testInfo, app, report)
    expectHarness(report)
    const alpha1 = report.turns.find(turn => turn.executor === 'alpha' && turn.dispatch === 1)!
    const alpha2 = report.turns.find(turn => turn.executor === 'alpha' && turn.dispatch === 2)!
    const cacheWriteOf = (turn: CostReport['turns'][number]) =>
      turn.cacheWrite > 0 ? turn.cacheWrite : turn.derivedCacheWrite
    if (mode === 'fake') {
      expect(report.model).toBe('test-model')
      expect(alpha1.cacheWrite).toBe(18_000)
      expect(alpha2.cacheWrite).toBe(0)
      expect(alpha2.cacheRead).toBe(20_000)
    } else {
      expect(report.model, 'real model from the rollout').not.toBe('')
      expect(report.provider, 'real provider from the rollout').not.toBe('')
      expect(alpha2.cacheRead, 'second dispatch reads the session cache').toBeGreaterThan(0)
      expect(cacheWriteOf(alpha2), 'second dispatch cache write against 17.6k').toBeLessThan(17_600)
      expect(cacheWriteOf(alpha2), 'second dispatch writes less than the first').toBeLessThan(
        cacheWriteOf(alpha1),
      )
    }
  } finally {
    await app.electronApp.close().catch(() => undefined)
    await new Promise<void>(done => claude.server.close(() => done()))
    await fixture.dispose()
    expect(await hashProfileFiles(personalCodexHome()), '~/.codex profile hash').toEqual(
      profileBefore,
    )
  }
}

test.describe('E-04 fake rehearsal', () => {
  test.skip(realModelEnabled(), 'The real-model invocation runs only the paid case')
  test.skip(process.platform === 'win32', 'Codex lifecycle hooks are not used on Windows')

  test('three dispatches and the token parser against the fake Responses API', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(420_000)
    await runScenario('fake', testInfo)
  })
})

test.describe('E-04 real model cost', () => {
  test.skip(!realModelEnabled(), 'Requires OPENCOVE_TEST_REAL_MODEL=1 and the paid authorization')
  test.skip(process.platform === 'win32', 'Codex lifecycle hooks are not used on Windows')

  test('second dispatch on the same executor reuses the session cache', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(900_000)
    await runScenario('real', testInfo)
  })
})
