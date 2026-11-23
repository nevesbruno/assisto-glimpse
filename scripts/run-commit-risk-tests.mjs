#!/usr/bin/env node
// Commit gate policy: keep the commit fast. No E2E, no build, no lint:fix; E2E runs in PR CI.
// Risk suites are selected by staged path, never by an arbitrary time cap.
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

// Persistence, platform and agent changes can break native recovery contracts.
const NATIVE_RECOVERY_PATHS = [
  /^src\/platform\//,
  /^src\/contexts\/agent\//,
  /^src\/app\/main\/.*(?:persist|storage|database|sqlite|migration|recovery|store)/i,
  /^tests\/contract\/platform\//,
]

// Canvas links, dispatch and the approval surface live behind these paths.
const ORCHESTRATION_PATHS = [/^src\/contexts\/orchestration\//, /^src\/app\/main\/controlSurface\//]

const ORCHESTRATION_TESTS = [
  'tests/unit/contexts/orchestration',
  'tests/unit/app/orchestrationHandlers.spec.ts',
  'tests/contract/orchestration',
  'tests/integration/orchestration',
]

function readStagedFiles() {
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    process.stderr.write(
      `[commit-risk] Cannot read staged files: ${result.error ?? result.stderr}\n`,
    )
    process.exit(1)
  }
  return result.stdout
    .split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

function matches(files, patterns) {
  return files.some(file => patterns.some(pattern => pattern.test(file)))
}

function runStep(label, command, args) {
  process.stdout.write(`[commit-risk] ${label}: ${command} ${args.join(' ')}\n`)
  const started = Date.now()
  const result = spawnSync(command, args, { stdio: 'inherit' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.error) {
    process.stderr.write(`[commit-risk] ${label} could not start: ${result.error.message}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `[commit-risk] ${label} ${result.status === 0 ? 'passed' : `failed (${result.status})`} in ${seconds}s\n`,
  )
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const stagedFiles = readStagedFiles()
if (stagedFiles.length === 0) {
  process.stdout.write('[commit-risk] No staged files; nothing to verify.\n')
  process.exit(0)
}

const startedAt = Date.now()
const needsNativeRecovery = matches(stagedFiles, NATIVE_RECOVERY_PATHS)
const needsOrchestration = matches(stagedFiles, ORCHESTRATION_PATHS)

if (!needsNativeRecovery) {
  process.stdout.write(
    '[commit-risk] skipped test:terminal-recovery:native (no platform, agent, main persistence or platform contract path staged).\n',
  )
}
if (!needsOrchestration) {
  process.stdout.write(
    '[commit-risk] skipped orchestration unit/contract/integration suites (no orchestration or controlSurface path staged).\n',
  )
}

if (needsNativeRecovery) {
  runStep('native recovery', PNPM_COMMAND, ['test:terminal-recovery:native'])
}

if (needsOrchestration) {
  const workers = Math.max(1, Math.floor(os.availableParallelism() / 2))
  runStep('orchestration suites', PNPM_COMMAND, [
    'exec',
    'vitest',
    'run',
    `--maxWorkers=${workers}`,
    ...ORCHESTRATION_TESTS,
  ])
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
process.stdout.write(`[commit-risk] done in ${seconds}s.\n`)
