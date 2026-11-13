import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCodexThreadWriterLockPath } from '../../../src/contexts/orchestration/infrastructure/codex/CodexWriterLock'
import {
  CodexWriterLockRecoveryExhaustedError,
  isCodexActiveWriterError,
  recoverCodexWriterLock,
  runCodexResumeWithRetry,
  waitForCodexWriterLockRelease,
  probeCodexWriterLock,
  type CodexWriterLockRecoveryDeps,
} from '../../../src/app/main/controlSurface/handlers/codexResumeRecovery'

describe('codex resume writer recovery', () => {
  it('passes through immediately when the writer lock is available', async () => {
    const probe = vi.fn(async () => 'available' as const)
    const sleep = vi.fn(async () => undefined)

    await expect(
      waitForCodexWriterLockRelease({
        resumeSessionId: 'thread-1',
        maxWaitMs: 500,
        pollIntervalMs: 100,
        probe,
        sleep,
      }),
    ).resolves.toBe('available')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('waits only up to the configured bound while the writer lock remains occupied', async () => {
    let nowMs = 0
    const probe = vi.fn(async () => 'occupied' as const)
    const sleep = vi.fn(async (delayMs: number) => {
      nowMs += delayMs
    })

    await expect(
      waitForCodexWriterLockRelease({
        resumeSessionId: 'thread-1',
        maxWaitMs: 250,
        pollIntervalMs: 100,
        probe,
        sleep,
        now: () => nowMs,
      }),
    ).resolves.toBe('timed_out')
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(nowMs).toBe(250)
  })

  it('continues as soon as an occupied writer lock becomes available', async () => {
    const probe = vi.fn().mockResolvedValueOnce('occupied').mockResolvedValueOnce('available')

    await expect(
      waitForCodexWriterLockRelease({
        resumeSessionId: 'thread-1',
        maxWaitMs: 500,
        pollIntervalMs: 100,
        probe,
        sleep: async () => undefined,
      }),
    ).resolves.toBe('available')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('recognizes both active-writer error signatures', () => {
    expect(isCodexActiveWriterError(new Error('JSON-RPC error -32600'))).toBe(true)
    expect(isCodexActiveWriterError('thread already has an active writer')).toBe(true)
    expect(isCodexActiveWriterError(new Error('executable missing'))).toBe(false)
  })

  it('retries bounded active-writer failures and returns the next successful launch', async () => {
    const launch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('already has an active writer'))
      .mockRejectedValueOnce(new Error('code -32600'))
      .mockResolvedValueOnce('session-3')
    const sleep = vi.fn(async () => undefined)

    await expect(
      runCodexResumeWithRetry({ launch, maxAttempts: 3, backoffMs: [100, 200], sleep }),
    ).resolves.toBe('session-3')
    expect(launch).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 100)
    expect(sleep).toHaveBeenNthCalledWith(2, 200)
  })

  it('stops at the hard retry limit and preserves the active-writer cause', async () => {
    const launch = vi.fn(async () => {
      throw new Error('thread already has an active writer (-32600)')
    })

    await expect(
      runCodexResumeWithRetry({
        launch,
        maxAttempts: 3,
        backoffMs: [10, 20],
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(CodexWriterLockRecoveryExhaustedError)
    expect(launch).toHaveBeenCalledTimes(3)
  })

  it('resolves the default Codex home when CODEX_HOME is absent', () => {
    expect(resolveCodexThreadWriterLockPath('thread-1', undefined)).toBe(
      join(homedir(), '.codex', 'thread-writer-locks', 'thread-1.lock'),
    )
  })

  describe('recoverCodexWriterLock', () => {
    const hash = (letter: string) => letter.repeat(64)
    const appServer = (token: string, cwd = '/work') =>
      `/bin/codex -c model=x app-server --listen ws://127.0.0.1:9 --ws-auth capability-token ` +
      `--ws-token-sha256 ${token} -c projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`

    const remoteTui = (
      options: {
        threadId?: string
        cwd?: string
        url?: string
        /** `null` omits the token env pair, like a third-party remote client. */
        tokenEnv?: string | null
        withRemote?: boolean
      } = {},
    ) => {
      const parts = ['/home/bruno/.local/bin/codex', 'resume', options.threadId ?? 'thread-1']
      if (options.withRemote ?? true) {
        parts.push('--remote', options.url ?? 'ws://127.0.0.1:43127')
        const tokenEnv =
          options.tokenEnv === undefined ? 'OPENCOVE_EXECUTOR_REMOTE_TOKEN' : options.tokenEnv
        if (tokenEnv !== null) {
          parts.push('--remote-auth-token-env', tokenEnv)
        }
      }
      parts.push('-C', options.cwd ?? '/work')
      return parts.join(' ')
    }

    function ownerRig(holders: { pid: number; commandLine: string }[]) {
      const signals: [number, string][] = []
      const alive = new Set(holders.map(holder => holder.pid))
      const deps: CodexWriterLockRecoveryDeps = {
        listOwnerPids: async () =>
          holders
            .map(holder => holder.pid)
            .filter(pid => alive.has(pid))
            .sort((a, b) => a - b),
        readCommandLine: async pid =>
          holders.find(holder => holder.pid === pid)?.commandLine ?? null,
        killGroup: (pid, signal) => {
          signals.push([pid, signal])
          alive.delete(pid)
        },
        isAlive: pid => alive.has(pid),
        sleep: async () => undefined,
      }
      return { deps, signals }
    }

    it('ends the app-server whose hash matches the link and resumes when the lock is released', async () => {
      const { deps, signals } = ownerRig([{ pid: 77, commandLine: appServer(hash('a')) }])

      await expect(
        recoverCodexWriterLock(
          {
            resumeSessionId: 'thread-1',
            codexHome: '/codex-home',
            cwd: '/work',
            expectedTokenSha256: hash('a'),
            waitMs: 100,
          },
          deps,
        ),
      ).resolves.toEqual({ outcome: 'released', killedPids: [77] })
      expect(signals).toEqual([[77, 'SIGTERM']])
    })

    it('never ends an app-server of another project even with the expected hash', async () => {
      const { deps, signals } = ownerRig([{ pid: 77, commandLine: appServer(hash('a'), '/other') }])

      await expect(
        recoverCodexWriterLock(
          {
            resumeSessionId: 'thread-1',
            codexHome: '/codex-home',
            cwd: '/work',
            expectedTokenSha256: hash('a'),
            waitMs: 0,
          },
          deps,
        ),
      ).resolves.toMatchObject({ outcome: 'held', killedPids: [] })
      expect(signals).toEqual([])
    })

    it('never ends a lock holder whose identity is unknown', async () => {
      const { deps, signals } = ownerRig([{ pid: 77, commandLine: '/usr/bin/other --lock' }])

      const result = await recoverCodexWriterLock(
        {
          resumeSessionId: 'thread-1',
          codexHome: '/codex-home',
          cwd: '/work',
          expectedTokenSha256: hash('a'),
          waitMs: 0,
        },
        deps,
      )
      expect(result.outcome).toBe('held')
      expect(result.outcome === 'held' ? result.owners.map(owner => owner.pid) : []).toEqual([77])
      expect(signals).toEqual([])
    })

    it('never ends an app-server of the same project when the link has no token', async () => {
      const { deps, signals } = ownerRig([{ pid: 77, commandLine: appServer(hash('b')) }])

      await expect(
        recoverCodexWriterLock(
          {
            resumeSessionId: 'thread-1',
            codexHome: '/codex-home',
            cwd: '/work',
            expectedTokenSha256: null,
            protectedPids: [42],
            waitMs: 0,
          },
          deps,
        ),
      ).resolves.toMatchObject({ outcome: 'held', killedPids: [] })
      expect(signals).toEqual([])
    })

    it('never ends an app-server whose hash differs from the link, even on the same cwd', async () => {
      const { deps, signals } = ownerRig([{ pid: 77, commandLine: appServer(hash('b')) }])

      await expect(
        recoverCodexWriterLock(
          {
            resumeSessionId: 'thread-1',
            codexHome: '/codex-home',
            cwd: '/work',
            expectedTokenSha256: hash('a'),
            waitMs: 0,
          },
          deps,
        ),
      ).resolves.toMatchObject({
        outcome: 'held',
        killedPids: [],
        owners: [expect.objectContaining({ pid: 77 })],
      })
      expect(signals).toEqual([])
    })

    it('never ends a pid protected by another link even when the hash matches', async () => {
      const { deps, signals } = ownerRig([{ pid: 42, commandLine: appServer(hash('b')) }])

      await expect(
        recoverCodexWriterLock(
          {
            resumeSessionId: 'thread-1',
            codexHome: '/codex-home',
            cwd: '/work',
            expectedTokenSha256: hash('b'),
            protectedPids: [42],
            waitMs: 0,
          },
          deps,
        ),
      ).resolves.toMatchObject({ outcome: 'held', killedPids: [] })
      expect(signals).toEqual([])
    })

    it('never ends an app-server whose cwd only shares a prefix with the project path', async () => {
      const { deps, signals } = ownerRig([
        { pid: 77, commandLine: appServer(hash('a'), '/work-other') },
      ])

      await expect(
        recoverCodexWriterLock(
          {
            resumeSessionId: 'thread-1',
            codexHome: '/codex-home',
            cwd: '/work',
            expectedTokenSha256: hash('a'),
            waitMs: 0,
          },
          deps,
        ),
      ).resolves.toMatchObject({ outcome: 'held', killedPids: [] })
      expect(signals).toEqual([])
    })

    it('never ends a protected service even when it holds the lock of the same project', async () => {
      const { deps, signals } = ownerRig([{ pid: 42, commandLine: appServer(hash('b')) }])

      await expect(
        recoverCodexWriterLock(
          {
            resumeSessionId: 'thread-1',
            codexHome: '/codex-home',
            cwd: '/work',
            expectedTokenSha256: null,
            protectedPids: [42],
            waitMs: 0,
          },
          deps,
        ),
      ).resolves.toMatchObject({ outcome: 'held', killedPids: [] })
      expect(signals).toEqual([])
    })

    describe('remote TUI holders', () => {
      const recoverTui = async (
        commandLine: string,
        overrides: {
          protectedPids?: readonly number[]
          waitMs?: number
          threadId?: string
          cwd?: string
        } = {},
      ) => {
        const { deps, signals } = ownerRig([{ pid: 99, commandLine }])
        const result = await recoverCodexWriterLock(
          {
            resumeSessionId: overrides.threadId ?? 'thread-1',
            codexHome: '/codex-home',
            cwd: overrides.cwd ?? '/work',
            expectedTokenSha256: hash('a'),
            protectedPids: overrides.protectedPids,
            waitMs: overrides.waitMs ?? 0,
          },
          deps,
        )
        return { result, signals }
      }

      it('ends the Glimpse remote TUI of the same thread and cwd', async () => {
        const { result, signals } = await recoverTui(remoteTui())

        expect(result).toEqual({ outcome: 'released', killedPids: [99] })
        expect(signals).toEqual([[99, 'SIGTERM']])
      })

      it('never ends a user TUI of the same thread without the Glimpse remote marker', async () => {
        const { result, signals } = await recoverTui(remoteTui({ withRemote: false }))

        expect(result).toMatchObject({ outcome: 'held', killedPids: [] })
        expect(signals).toEqual([])
      })

      it('never ends a remote TUI of another thread', async () => {
        const { result, signals } = await recoverTui(remoteTui({ threadId: 'thread-2' }))

        expect(result).toMatchObject({ outcome: 'held', killedPids: [] })
        expect(signals).toEqual([])
      })

      it('never ends a remote TUI of another cwd, even one that shares a prefix', async () => {
        const { result, signals } = await recoverTui(remoteTui({ cwd: '/work-other' }))

        expect(result).toMatchObject({ outcome: 'held', killedPids: [] })
        expect(signals).toEqual([])
      })

      it('never ends a remote TUI without the Glimpse token env variable', async () => {
        const withoutEnv = await recoverTui(remoteTui({ tokenEnv: null }))
        const otherEnv = await recoverTui(remoteTui({ tokenEnv: 'CODEX_REMOTE_TOKEN' }))

        expect(withoutEnv.result).toMatchObject({ outcome: 'held', killedPids: [] })
        expect(withoutEnv.signals).toEqual([])
        expect(otherEnv.result).toMatchObject({ outcome: 'held', killedPids: [] })
        expect(otherEnv.signals).toEqual([])
      })

      it('never ends a remote TUI whose endpoint is not loopback', async () => {
        const { result, signals } = await recoverTui(remoteTui({ url: 'ws://192.168.0.5:43127' }))

        expect(result).toMatchObject({ outcome: 'held', killedPids: [] })
        expect(signals).toEqual([])
      })

      it('never ends a remote TUI whose pid another link protects', async () => {
        const { result, signals } = await recoverTui(remoteTui(), { protectedPids: [99] })

        expect(result).toMatchObject({ outcome: 'held', killedPids: [] })
        expect(signals).toEqual([])
      })
    })

    it('reports unknown when the lock probe fails', async () => {
      const deps: CodexWriterLockRecoveryDeps = {
        listOwnerPids: async () => null,
        readCommandLine: async () => null,
        killGroup: () => undefined,
        isAlive: () => false,
        sleep: async () => undefined,
      }

      await expect(
        recoverCodexWriterLock(
          { resumeSessionId: 'thread-1', codexHome: '/codex-home', cwd: '/work', waitMs: 0 },
          deps,
        ),
      ).resolves.toEqual({ outcome: 'unknown', owners: [] })
    })
  })

  it.skipIf(process.platform !== 'darwin')(
    'observes a real flock holder and waits until the kernel releases it',
    async () => {
      const codexHome = await mkdtemp(join(tmpdir(), 'opencove-codex-writer-lock-'))
      const lockDirectory = join(codexHome, 'thread-writer-locks')
      const lockPath = join(lockDirectory, 'thread-real.lock')
      await mkdir(lockDirectory, { recursive: true })
      const holder = spawn(
        'perl',
        [
          '-MFcntl=:flock',
          '-e',
          '$|=1; open my $fh, ">>", $ARGV[0] or die $!; flock($fh, LOCK_EX) or die $!; print "ready\\n"; select undef, undef, undef, 3;',
          lockPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )

      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => rejectPromise(new Error('flock holder not ready')), 2_000)
          holder.stdout.once('data', () => {
            clearTimeout(timer)
            resolvePromise()
          })
          holder.once('error', rejectPromise)
        })

        await expect(
          probeCodexWriterLock({ resumeSessionId: 'thread-real', codexHome }),
        ).resolves.toBe('occupied')
        await expect(
          waitForCodexWriterLockRelease({
            resumeSessionId: 'thread-real',
            maxWaitMs: 5_000,
            pollIntervalMs: 50,
            probe: async resumeSessionId =>
              await probeCodexWriterLock({ resumeSessionId, codexHome }),
          }),
        ).resolves.toBe('available')
      } finally {
        holder.kill('SIGKILL')
        await rm(codexHome, { recursive: true, force: true })
      }
    },
    8_000,
  )
})
