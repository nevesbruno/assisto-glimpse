// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildCodexAppServerArgs } from '../../../../../src/contexts/orchestration/infrastructure/codex/codexProcessEnv'
import {
  findPendingHooks,
  hookOverridesFromApproved,
} from '../../../../../src/contexts/orchestration/infrastructure/codex/CodexHookTrust'

const hook = (key: string, currentHash: string, trustStatus: string) => ({
  key,
  currentHash,
  trustStatus: trustStatus as 'managed',
  eventName: 'preToolUse',
})

describe('CodexHookTrust (F2-11)', () => {
  it('turns approved pairs into overrides by key, last hash per key', () => {
    expect(
      hookOverridesFromApproved([
        { key: 'a', currentHash: 'h1' },
        { key: 'b', currentHash: 'h2' },
        { key: 'a', currentHash: 'h3' },
      ]),
    ).toEqual([
      { key: 'a', trustedHash: 'h3' },
      { key: 'b', trustedHash: 'h2' },
    ])
  })

  it('emits the overrides as one inline table through buildCodexAppServerArgs', () => {
    const args = buildCodexAppServerArgs({
      port: 1,
      tokenSha256: 'x',
      cwd: '/w',
      hookTrust: hookOverridesFromApproved([{ key: 'k:1', currentHash: 'hh' }]),
    })
    expect(args).toContain('hooks.state={"k:1"={trusted_hash="hh"}}')
  })

  it('emits no hooks override without approvals', () => {
    const args = buildCodexAppServerArgs({ port: 1, tokenSha256: 'x', cwd: '/w', hookTrust: [] })
    expect(args.some(arg => arg.startsWith('hooks.state'))).toBe(false)
  })

  it('lists untrusted and modified hooks without an approved pair as pending', () => {
    const pending = findPendingHooks(
      [
        hook('a', 'h1', 'untrusted'),
        hook('b', 'h2', 'modified'),
        hook('c', 'h3', 'trusted'),
        hook('d', 'h4', 'managed'),
        hook('e', 'h5', 'untrusted'),
        hook('f', 'new', 'modified'),
      ],
      [
        { key: 'e', currentHash: 'h5' },
        { key: 'f', currentHash: 'old' },
      ],
    )
    expect(pending.map(item => [item.key, item.currentHash, item.event])).toEqual([
      ['a', 'h1', 'preToolUse'],
      ['b', 'h2', 'preToolUse'],
      ['f', 'new', 'preToolUse'],
    ])
  })
})
