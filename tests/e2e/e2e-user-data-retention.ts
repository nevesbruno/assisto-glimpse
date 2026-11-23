import { readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'

// Each Electron test run gets its own userData directory. The uv cache now lives outside it, but
// the app data still piles up per run, so the creator prunes old runs and keeps the latest ones
// for debugging. A directory whose owner process is still alive is never deleted, which also
// covers a second Playwright worker of the same run (it has another pid, same machine).
const OWNER_FILE = '.e2e-owner.json'
const KEPT_RUNS = 3
// A directory touched less than a minute ago may be between mkdtemp and the owner marker.
const RECENT_MS = 60_000
const RUN_ID = `${process.pid}-${Date.now()}`

interface OwnerRecord {
  pid: number
  host: string
  run: string
}

interface Candidate {
  dir: string
  run: string
  alive: boolean
  mtimeMs: number
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A process of another user is alive but not signalable.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Chromium writes `SingletonLock -> host-pid` while the app holds the userData directory. */
async function singletonOwnerAlive(dir: string): Promise<boolean> {
  try {
    const target = await readlink(path.join(dir, 'SingletonLock'))
    const match = /^(.*)-(\d+)$/.exec(target)
    if (!match || match[1] !== hostname()) {
      return false
    }
    return processAlive(Number(match[2]))
  } catch {
    return false
  }
}

async function candidateOf(dir: string): Promise<Candidate | null> {
  try {
    const info = await stat(dir)
    const raw = await readFile(path.join(dir, OWNER_FILE), 'utf8')
    const record = JSON.parse(raw) as Partial<OwnerRecord>
    if (typeof record.pid !== 'number' || typeof record.run !== 'string') {
      throw new Error('incomplete owner marker')
    }
    return {
      dir,
      run: record.run,
      // The marker can outlive its process while Chromium already rewrote the lock with the new
      // owner, so either signal is enough to keep the directory.
      alive:
        (record.host === hostname() && processAlive(record.pid)) ||
        (await singletonOwnerAlive(dir)),
      mtimeMs: info.mtimeMs,
    }
  } catch {
    // Legacy directory without a marker: the lock is the only liveness signal left.
    try {
      const info = await stat(dir)
      return {
        dir,
        run: `legacy:${Math.floor(info.mtimeMs)}`,
        alive: await singletonOwnerAlive(dir),
        mtimeMs: info.mtimeMs,
      }
    } catch {
      return null
    }
  }
}

/** Removes old run directories of `prefix`, keeping `keepRuns` past runs and every live one. */
export async function pruneE2EUserDataDirs(
  parentDir: string,
  prefix: string,
  keepRuns = KEPT_RUNS,
): Promise<string[]> {
  const names = await readdir(parentDir).catch(() => [] as string[])
  const candidates = (
    await Promise.all(
      names
        .filter(name => name.startsWith(prefix))
        .map(name => candidateOf(path.join(parentDir, name))),
    )
  ).filter((candidate): candidate is Candidate => candidate !== null)
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)

  const keptRuns = new Set<string>()
  const doomed: string[] = []
  const now = Date.now()
  for (const candidate of candidates) {
    if (candidate.run === RUN_ID || candidate.alive || now - candidate.mtimeMs < RECENT_MS) {
      continue
    }
    if (!keptRuns.has(candidate.run) && keptRuns.size < keepRuns) {
      keptRuns.add(candidate.run)
      continue
    }
    doomed.push(candidate.dir)
  }
  const results = await Promise.allSettled(
    doomed.map(dir => rm(dir, { recursive: true, force: true })),
  )
  return doomed.filter((_dir, index) => results[index]?.status === 'fulfilled')
}

/** Marks the directory as owned by this test process so later runs can tell it is still alive. */
export async function claimE2EUserDataOwner(dir: string): Promise<void> {
  const record: OwnerRecord = { pid: process.pid, host: hostname(), run: RUN_ID }
  await writeFile(path.join(dir, OWNER_FILE), `${JSON.stringify(record)}\n`).catch(() => undefined)
}
