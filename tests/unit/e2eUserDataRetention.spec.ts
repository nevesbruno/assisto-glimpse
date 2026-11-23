import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claimE2EUserDataOwner, pruneE2EUserDataDirs } from '../e2e/e2e-user-data-retention'

const OWNER_FILE = '.e2e-owner.json'
const MINUTE_MS = 60_000
const OLD_MS = 10 * MINUTE_MS
const KEPT_RUN_AGES_MS = [2 * MINUTE_MS, 3 * MINUTE_MS, 4 * MINUTE_MS]
const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-retention-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async root => {
      if (!root.startsWith(tmpdir())) {
        throw new Error(`refusing to clean ${root}`)
      }
      await rm(root, { recursive: true, force: true })
    }),
  )
})

function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (typeof child.pid !== 'number') {
    throw new Error('failed to spawn helper process')
  }
  return child.pid
}

interface RunDirOptions {
  ageMs: number
  marker?: { pid: number; host: string; run: string }
  lockPid?: number
}

async function makeRunDir(root: string, name: string, options: RunDirOptions): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir)
  if (options.marker) {
    await writeFile(path.join(dir, OWNER_FILE), `${JSON.stringify(options.marker)}\n`)
  }
  if (options.lockPid !== undefined) {
    await symlink(`${hostname()}-${options.lockPid}`, path.join(dir, 'SingletonLock'))
  }
  // Writes above bump the directory mtime, so age the directory last.
  const when = new Date(Date.now() - options.ageMs)
  await utimes(dir, when, when)
  return dir
}

async function makeKeptRuns(root: string): Promise<string[]> {
  return Promise.all(
    KEPT_RUN_AGES_MS.map((ageMs, index) =>
      makeRunDir(root, `run-kept-${index}`, {
        ageMs,
        marker: { pid: exitedPid(), host: hostname(), run: `kept-run-${index}` },
      }),
    ),
  )
}

async function exists(dir: string): Promise<boolean> {
  return stat(dir).then(
    () => true,
    () => false,
  )
}

describe('e2e userData retention', () => {
  it('keeps a directory whose owner marker is dead but whose SingletonLock is alive', async () => {
    const root = await makeRoot()
    await makeKeptRuns(root)
    const candidate = await makeRunDir(root, 'run-lock-alive', {
      ageMs: OLD_MS,
      marker: { pid: exitedPid(), host: hostname(), run: 'dead-marker-run' },
      lockPid: process.pid,
    })

    expect(await pruneE2EUserDataDirs(root, 'run-')).toEqual([])
    expect(await exists(candidate)).toBe(true)
  })

  it('prunes an ancient dead run beyond the kept runs when no lock proves liveness', async () => {
    const root = await makeRoot()
    await makeKeptRuns(root)
    const candidate = await makeRunDir(root, 'run-dead', {
      ageMs: OLD_MS,
      marker: { pid: exitedPid(), host: hostname(), run: 'dead-marker-run' },
    })

    expect(await pruneE2EUserDataDirs(root, 'run-')).toEqual([candidate])
    expect(await exists(candidate)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'prunes an ancient run whose marker and SingletonLock both point at a dead pid',
    async () => {
      const root = await makeRoot()
      await makeKeptRuns(root)
      const dead = exitedPid()
      const candidate = await makeRunDir(root, 'run-dead-lock', {
        ageMs: OLD_MS,
        marker: { pid: dead, host: hostname(), run: 'dead-marker-run' },
        lockPid: dead,
      })

      expect(await pruneE2EUserDataDirs(root, 'run-')).toEqual([candidate])
      expect(await exists(candidate)).toBe(false)
    },
  )

  it('keeps an ancient run whose marker records a live local process', async () => {
    const root = await makeRoot()
    await makeKeptRuns(root)
    const candidate = await makeRunDir(root, 'run-live', {
      ageMs: OLD_MS,
      marker: { pid: process.pid, host: hostname(), run: 'live-marker-run' },
    })

    expect(await pruneE2EUserDataDirs(root, 'run-')).toEqual([])
    expect(await exists(candidate)).toBe(true)
  })

  it('writes the owner marker and never prunes the current run', async () => {
    const root = await makeRoot()
    const current = path.join(root, 'run-current')
    await mkdir(current)
    await claimE2EUserDataOwner(current)
    await makeKeptRuns(root)
    const when = new Date(Date.now() - OLD_MS)
    await utimes(current, when, when)

    const record = JSON.parse(await readFile(path.join(current, OWNER_FILE), 'utf8')) as {
      pid: number
      host: string
      run: string
    }
    expect(record).toMatchObject({ pid: process.pid, host: hostname() })
    expect(typeof record.run).toBe('string')

    expect(await pruneE2EUserDataDirs(root, 'run-')).toEqual([])
    expect(await exists(current)).toBe(true)
  })
})
