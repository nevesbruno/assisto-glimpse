// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createCodexOrphanReaper } from '../../../../../src/contexts/orchestration/infrastructure/codex/CodexOrphanReaper'

const link = (servicePid: number | null, serviceTokenSha256: string | null) =>
  ({ servicePid, serviceTokenSha256 }) as never

function setup(
  commandLines: Record<number, string | null>,
  aliveAfterTerm = false,
  lockOwnerPids?: readonly number[],
) {
  const signals: [number, string][] = []
  let alive = true
  const reap = createCodexOrphanReaper({
    readCommandLine: async pid => commandLines[pid] ?? null,
    killGroup: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGKILL' || !aliveAfterTerm) {
        alive = false
      }
    },
    isAlive: () => alive,
    sleep: async () => undefined,
    ...(lockOwnerPids ? { listLockOwnerPids: async () => lockOwnerPids } : {}),
  })
  return { reap, signals }
}

const cmd = (hash: string) =>
  `codex app-server --listen ws://127.0.0.1:9 --ws-auth capability-token --ws-token-sha256 ${hash} -c x`

describe('CodexOrphanReaper (F2-11)', () => {
  it('ends the group when pid and token hash match the command line', async () => {
    const { reap, signals } = setup({ 10: cmd('abc') })
    await reap([link(10, 'abc')])
    expect(signals).toEqual([[10, 'SIGTERM']])
  })

  it('never touches a reused pid whose command line has another hash', async () => {
    const { reap, signals } = setup({ 10: cmd('zzz') })
    await reap([link(10, 'abc')])
    expect(signals).toEqual([])
  })

  it('skips links without pid or hash and pids that are gone', async () => {
    const { reap, signals } = setup({})
    await reap([link(null, 'abc'), link(11, null), link(12, 'abc')])
    expect(signals).toEqual([])
  })

  it('escalates to SIGKILL when SIGTERM does not end the process', async () => {
    const { reap, signals } = setup({ 10: cmd('abc') }, true)
    await reap([link(10, 'abc')])
    expect(signals).toEqual([
      [10, 'SIGTERM'],
      [10, 'SIGKILL'],
    ])
  })

  it('ends the thread writer lock owner when the stored pid is stale', async () => {
    const { reap, signals } = setup({ 11: cmd('abc') }, false, [11])
    await reap([
      { servicePid: 10, serviceTokenSha256: 'abc', executorSessionRef: 'thread-1' } as never,
    ])
    expect(signals).toEqual([[11, 'SIGTERM']])
  })

  it('never ends a thread writer lock owner whose command line has another hash', async () => {
    const { reap, signals } = setup({ 11: cmd('zzz') }, false, [11])
    await reap([
      { servicePid: null, serviceTokenSha256: 'abc', executorSessionRef: 'thread-1' } as never,
    ])
    expect(signals).toEqual([])
  })

  it('does not stop at the first failing link', async () => {
    const signals: number[] = []
    const reap = createCodexOrphanReaper({
      readCommandLine: async pid => {
        if (pid === 1) {
          throw new Error('ps failed')
        }
        return cmd('abc')
      },
      killGroup: pid => signals.push(pid),
      isAlive: () => false,
      sleep: async () => undefined,
    })
    await reap([link(1, 'abc'), link(2, 'abc')])
    expect(signals).toEqual([2])
  })

  it.each([-1, 0, 1])('never signals pid %i even when the command line matches', async pid => {
    const { reap, signals } = setup({ [pid]: cmd('abc') })
    await reap([link(pid, 'abc')])
    expect(signals).toEqual([])
  })
})
