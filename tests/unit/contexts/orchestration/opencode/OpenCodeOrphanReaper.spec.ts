/* eslint-disable no-await-in-loop -- sequential assertions. */
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createOpenCodeOrphanReaper,
  matchesOpenCodeServe,
} from '../../../../../src/contexts/orchestration/infrastructure/opencode/OpenCodeOrphanReaper'

const link = (servicePid: number | null) => ({ servicePid, provider: 'opencode' }) as never

function setup(commandLines: Record<number, string | null>, aliveAfterTerm = false) {
  const signals: [number, string][] = []
  let alive = true
  const reap = createOpenCodeOrphanReaper({
    readCommandLine: async pid => commandLines[pid] ?? null,
    killGroup: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGKILL' || !aliveAfterTerm) {
        alive = false
      }
    },
    isAlive: () => alive,
    sleep: async () => undefined,
  })
  return { reap, signals }
}

const cmd = (extra = '') =>
  `/home/u/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4555${extra}`

describe('matchesOpenCodeServe (F3-01)', () => {
  it('accepts the serve line on loopback with flags before or after', () => {
    expect(matchesOpenCodeServe(cmd())).toBe(true)
    expect(matchesOpenCodeServe('/usr/bin/opencode serve --port 4555 --hostname 127.0.0.1')).toBe(
      true,
    )
    expect(matchesOpenCodeServe('/usr/bin/opencode serve --hostname=127.0.0.1 --port 1')).toBe(true)
  })

  it('refuses another command, another host and an ambiguous line', () => {
    expect(matchesOpenCodeServe('/usr/bin/opencode acp --hostname 127.0.0.1')).toBe(false)
    expect(matchesOpenCodeServe('/usr/bin/opencode serve --hostname 0.0.0.0')).toBe(false)
    expect(
      matchesOpenCodeServe('/usr/bin/node server.js opencode serve --hostname 127.0.0.1'),
    ).toBe(false)
    expect(matchesOpenCodeServe('')).toBe(false)
  })
})

describe('OpenCodeOrphanReaper (F3-01)', () => {
  it('ends the group when the pid runs an opencode serve on loopback', async () => {
    const { reap, signals } = setup({ 10: cmd() })
    await reap([link(10)])
    expect(signals).toEqual([[10, 'SIGTERM']])
  })

  it('never touches a reused pid with another command line', async () => {
    const { reap, signals } = setup({ 10: '/usr/bin/vim /work/file.ts' })
    await reap([link(10)])
    expect(signals).toEqual([])
  })

  it('never touches a serve outside loopback', async () => {
    const { reap, signals } = setup({
      10: '/usr/bin/opencode serve --hostname 0.0.0.0 --port 4555',
    })
    await reap([link(10)])
    expect(signals).toEqual([])
  })

  it('skips links without pid, pids that are gone and pids at or below 1', async () => {
    const { reap, signals } = setup({ 12: cmd() })
    await reap([link(null), link(11)])
    expect(signals).toEqual([])
    for (const pid of [-1, 0, 1]) {
      const guarded = setup({ [pid]: cmd() })
      await guarded.reap([link(pid)])
      expect(guarded.signals).toEqual([])
    }
  })

  it('escalates to SIGKILL when SIGTERM does not end the process', async () => {
    const { reap, signals } = setup({ 10: cmd() }, true)
    await reap([link(10)])
    expect(signals).toEqual([
      [10, 'SIGTERM'],
      [10, 'SIGKILL'],
    ])
  })

  it('does not stop at the first failing link', async () => {
    const signals: number[] = []
    const reap = createOpenCodeOrphanReaper({
      readCommandLine: async pid => {
        if (pid === 2) {
          throw new Error('ps failed')
        }
        return cmd()
      },
      killGroup: pid => signals.push(pid),
      isAlive: () => false,
      sleep: async () => undefined,
    })
    await reap([link(2), link(3)])
    expect(signals).toEqual([3])
  })
})
