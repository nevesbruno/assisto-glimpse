import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  cleanLegacyClaudeSettings,
  cleanLegacyCodexConfigToml,
  cleanLegacyCodexHooksFile,
  collectWholeFileStaleTrust,
  isLegacyOpenCoveCodexHooksFile,
  type StaleCodexTrust,
} from './legacyManagedHookCleanup'

export interface LegacyManagedHookStartupCleanupReport {
  readonly removedCount: number
  readonly failures: readonly { path: string; error: unknown }[]
}

export async function cleanupLegacyManagedHooksAtStartup(
  homeDirectory: string,
  markerPath?: string,
): Promise<LegacyManagedHookStartupCleanupReport> {
  const failures: Array<{ path: string; error: unknown }> = []
  let removedCount = 0
  const clean = async (path: string, operation: () => Promise<number>): Promise<void> => {
    try {
      removedCount += await operation()
    } catch (error) {
      failures.push({ path, error })
    }
  }
  const claudeSettingsPath = join(homeDirectory, '.claude', 'settings.json')
  const codexHooksPath = join(homeDirectory, '.codex', 'hooks.json')
  const codexConfigPath = join(homeDirectory, '.codex', 'config.toml')
  if (markerPath && (await readOptionalFile(markerPath)) !== null) {
    return { removedCount: 0, failures }
  }

  await clean(claudeSettingsPath, async () => {
    const raw = await readOptionalFile(claudeSettingsPath)
    if (raw === null) {
      return 0
    }
    const result = cleanLegacyClaudeSettings(JSON.parse(raw) as unknown)
    if (result.removedCount > 0) {
      await writeAtomic(claudeSettingsPath, serializeJson(result.content))
    }
    return result.removedCount
  })
  await clean(codexHooksPath, async () => {
    const raw = await readOptionalFile(codexHooksPath)
    if (raw === null) {
      return 0
    }
    const parsed = JSON.parse(raw) as unknown
    const wholeFile = isLegacyOpenCoveCodexHooksFile(parsed)
    const hooksResult = wholeFile ? null : cleanLegacyCodexHooksFile(parsed)
    const staleTrust = wholeFile
      ? collectWholeFileStaleTrust(parsed)
      : (hooksResult?.staleTrust ?? new Map<string, number>())
    const hooksRemoved = wholeFile ? 1 : (hooksResult?.removedCount ?? 0)
    if (hooksRemoved === 0) {
      return 0
    }

    // Trust first: if it fails, hooks.json stays intact and the next startup retries.
    const trustRemoved = await removeStaleCodexTrust(codexConfigPath, staleTrust)
    if (wholeFile) {
      await rm(codexHooksPath, { force: true })
    } else if (hooksResult) {
      await writeAtomic(codexHooksPath, serializeJson(hooksResult.content))
    }
    return hooksRemoved + trustRemoved
  })

  if (markerPath && failures.length === 0) {
    await writeMarker(markerPath)
  }
  return { removedCount, failures }
}

export function resolveLegacyManagedHookCleanupMarkerPath(userDataPath: string): string {
  return join(userDataPath, 'legacy-managed-hook-cleanup.done')
}

async function writeMarker(markerPath: string): Promise<void> {
  try {
    await mkdir(dirname(markerPath), { recursive: true })
    await writeFile(markerPath, `${new Date().toISOString()}\n`, 'utf8')
  } catch {
    // Best effort: without the marker the cleanup is idempotent and simply runs again.
  }
}

async function removeStaleCodexTrust(
  configPath: string,
  staleTrust: StaleCodexTrust,
): Promise<number> {
  const raw = await readOptionalFile(configPath)
  if (raw === null) {
    return 0
  }
  const result = cleanLegacyCodexConfigToml(raw, staleTrust)
  if (result.removedCount > 0) {
    await writeAtomic(configPath, result.content)
  }
  return result.removedCount
}

export function reportLegacyManagedHookCleanupFailures(
  report: LegacyManagedHookStartupCleanupReport,
): void {
  for (const failure of report.failures) {
    const detail = failure.error instanceof Error ? failure.error.message : String(failure.error)
    process.stderr.write(
      `[opencove] legacy Agent hook cleanup failed for ${failure.path}: ${detail}\n`,
    )
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const mode = await stat(path).then(value => value.mode & 0o777)
  const temporaryPath = join(
    dirname(path),
    `.opencove-cleanup-${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`,
  )
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode })
    await chmod(temporaryPath, mode)
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
