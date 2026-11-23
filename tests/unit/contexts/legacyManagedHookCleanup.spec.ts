import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_MANAGED_CLAUDE_HOOK_STATUS_MESSAGE,
  LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION,
  cleanLegacyClaudeSettings,
  cleanLegacyCodexConfigToml,
  cleanLegacyCodexHooksFile,
  collectWholeFileStaleTrust,
  isLegacyOpenCoveCodexHooksFile,
} from '../../../src/contexts/agent/infrastructure/legacyManagedHookCleanup'

const allStale = new Map([
  ['pre_tool_use', 0],
  ['stop', 0],
])

function fixture(name: string): string {
  return readFileSync(resolve('tests/fixtures/agent/legacy-managed-hooks', name), 'utf8')
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object')
  expect(value).not.toBeNull()
  return value as Record<string, unknown>
}

function eventGroups(value: unknown, eventName: string): unknown[] {
  const hooks = asRecord(asRecord(value).hooks)
  const groups = hooks[eventName]
  expect(Array.isArray(groups)).toBe(true)
  return groups as unknown[]
}

describe('legacy managed-hook residue cleanup', () => {
  it('INV-B1 removes only OpenCove Claude groups and preserves coexisting groups byte-for-byte', () => {
    const input = JSON.parse(fixture('claude-coexist.input.json')) as unknown
    const expected = JSON.parse(fixture('claude-coexist.expected.json')) as unknown
    const originalOrcaGroup = eventGroups(input, 'UserPromptSubmit')[1]
    const originalThirdPartyGroup = eventGroups(input, 'PostToolUse')[0]
    const orcaBytes = Buffer.from(JSON.stringify(originalOrcaGroup))
    const thirdPartyBytes = Buffer.from(JSON.stringify(originalThirdPartyGroup))

    const result = cleanLegacyClaudeSettings(input)
    const retainedOrcaGroup = eventGroups(result.content, 'UserPromptSubmit')[0]
    const retainedThirdPartyGroup = eventGroups(result.content, 'PostToolUse')[0]

    expect(result).toEqual({ content: expected, removedCount: 3 })
    expect(retainedOrcaGroup).toBe(originalOrcaGroup)
    expect(retainedThirdPartyGroup).toBe(originalThirdPartyGroup)
    expect(Buffer.from(JSON.stringify(retainedOrcaGroup))).toEqual(orcaBytes)
    expect(Buffer.from(JSON.stringify(retainedThirdPartyGroup))).toEqual(thirdPartyBytes)
  })

  it('INV-B1 identifies only a Codex hooks file with the exact frozen OpenCove description', () => {
    const managed = {
      description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION,
      hooks: { PreToolUse: [{ hooks: [{ command: 'legacy OpenCove command' }] }] },
    }
    const thirdParty = {
      ...managed,
      description: `${LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION} (copied)`,
    }

    expect(isLegacyOpenCoveCodexHooksFile(managed)).toBe(true)
    expect(isLegacyOpenCoveCodexHooksFile(thirdParty)).toBe(false)
    expect(isLegacyOpenCoveCodexHooksFile(null)).toBe(false)
  })

  it('INV-B1 preserves third-party Codex groups while removing explicitly marked groups', () => {
    const thirdPartyGroup = {
      hooks: [{ type: 'command', command: '/Applications/Orca.app/Contents/MacOS/orca hook' }],
    }
    const managedGroup = {
      description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION,
      hooks: [{ type: 'command', command: 'legacy' }],
    }
    const input = {
      description: 'Third-party hooks',
      hooks: { PreToolUse: [managedGroup, thirdPartyGroup] },
    }
    const thirdPartyBytes = Buffer.from(JSON.stringify(thirdPartyGroup))

    const result = cleanLegacyCodexHooksFile(input)
    const retained = eventGroups(result.content, 'PreToolUse')[0]

    expect(result.removedCount).toBe(1)
    expect(retained).toBe(thirdPartyGroup)
    expect(Buffer.from(JSON.stringify(retained))).toEqual(thirdPartyBytes)
    expect(asRecord(result.content).description).toBe('Third-party hooks')
  })

  it('INV-B1 removes only Codex state tables that reference the legacy hooks file', () => {
    const input = fixture('codex-config-coexist.input.toml')
    const expected = fixture('codex-config-coexist.expected.toml')

    expect(cleanLegacyCodexConfigToml(input, allStale)).toEqual({
      content: expected,
      removedCount: 2,
    })
  })

  it('INV-B2 removes empty Claude event and hooks keys while preserving other top-level keys', () => {
    const input = {
      env: { OPEN_COVE_USER_VALUE: 'keep' },
      hooks: {
        Notification: [
          {
            hooks: [
              {
                statusMessage: LEGACY_MANAGED_CLAUDE_HOOK_STATUS_MESSAGE,
                command: 'legacy',
              },
            ],
          },
        ],
      },
      theme: 'light',
      attribution: 'keep',
      skipDangerousModePermissionPrompt: false,
    }

    expect(cleanLegacyClaudeSettings(input)).toEqual({
      content: {
        env: { OPEN_COVE_USER_VALUE: 'keep' },
        theme: 'light',
        attribution: 'keep',
        skipDangerousModePermissionPrompt: false,
      },
      removedCount: 1,
    })
  })

  it('INV-B3 is idempotent across Claude JSON, Codex JSON, and Codex TOML', () => {
    const claudeFirst = cleanLegacyClaudeSettings(
      JSON.parse(fixture('claude-coexist.input.json')) as unknown,
    )
    const claudeSecond = cleanLegacyClaudeSettings(claudeFirst.content)
    expect(claudeSecond).toEqual({ content: claudeFirst.content, removedCount: 0 })
    expect(claudeSecond.content).toBe(claudeFirst.content)

    const codexFirst = cleanLegacyCodexHooksFile({
      hooks: {
        Stop: [{ hooks: [{ description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION }] }],
      },
    })
    const codexSecond = cleanLegacyCodexHooksFile(codexFirst.content)
    expect(codexSecond).toMatchObject({ content: codexFirst.content, removedCount: 0 })
    expect(codexSecond.content).toBe(codexFirst.content)

    const tomlFirst = cleanLegacyCodexConfigToml(
      fixture('codex-config-coexist.input.toml'),
      allStale,
    )
    const tomlSecond = cleanLegacyCodexConfigToml(tomlFirst.content, allStale)
    expect(tomlSecond).toEqual({ content: tomlFirst.content, removedCount: 0 })
  })

  it('INV-B4 leaves serializable JSON and a structurally intact TOML document', () => {
    const claude = cleanLegacyClaudeSettings(
      JSON.parse(fixture('claude-coexist.input.json')) as unknown,
    )
    expect(() => JSON.parse(JSON.stringify(claude.content))).not.toThrow()

    const toml = cleanLegacyCodexConfigToml(fixture('codex-config-coexist.input.toml'), allStale)
    expect(toml.content).toBe(fixture('codex-config-coexist.expected.toml'))
    expect(toml.content).toContain('[features]\nhooks = true')
    expect(toml.content).toContain('[projects."/repo"]\ntrust_level = "trusted"')
  })

  it('INV-B4 matches only exact table headers for the legacy .codex/hooks.json path', () => {
    const similarHeaders = [
      '[hooks.state."/tmp/hooks.json:stop:0:0"]',
      '[hooks.state."/tmp/.codex/hooks.json.backup:stop:0:0"]',
      '[hooks.state."/tmp/.codex/my-hooks.json:stop:0:0"]',
      'value = "[hooks.state.\\"/tmp/.codex/hooks.json:stop:0:0\\"]"',
      '[hooks.state]',
    ].join('\n')

    expect(cleanLegacyCodexConfigToml(similarHeaders, allStale)).toEqual({
      content: similarHeaders,
      removedCount: 0,
    })
  })

  it('preserves CRLF bytes around a removed Codex hooks.state table', () => {
    const input =
      '[hooks.state."C:\\\\Users\\\\redacted\\\\.codex\\\\hooks.json:stop:0:0"]\r\n' +
      'trusted_hash = "sha256:legacy"\r\n' +
      '[features]\r\n' +
      'hooks = true\r\n'

    expect(cleanLegacyCodexConfigToml(input, allStale)).toEqual({
      content: '[features]\r\nhooks = true\r\n',
      removedCount: 1,
    })
  })

  it('counts every removed Codex hooks.state table', () => {
    const eventsStale = new Map(Array.from({ length: 10 }, (_, index) => [`event_${index}`, 0]))
    const input = Array.from(
      { length: 10 },
      (_, index) =>
        `[hooks.state."/Users/redacted/.codex/hooks.json:event_${index}:0:0"]\ntrusted_hash = "sha256:${index}"\n`,
    ).join('\n')

    expect(cleanLegacyCodexConfigToml(input, eventsStale)).toEqual({
      content: '',
      removedCount: 10,
    })
  })

  it('INV-B5 treats absent shapes and damaged TOML as safe no-ops', () => {
    for (const value of [null, undefined, '{ damaged', [], { theme: 'dark' }, { hooks: null }]) {
      expect(cleanLegacyClaudeSettings(value)).toEqual({ content: value, removedCount: 0 })
      expect(cleanLegacyCodexHooksFile(value)).toMatchObject({ content: value, removedCount: 0 })
    }

    const damaged = '[hooks.state."/tmp/.codex/hooks.json:stop:0:0"]\nkey = true\n[broken'
    expect(cleanLegacyCodexConfigToml(damaged, allStale)).toEqual({
      content: damaged,
      removedCount: 0,
    })
  })

  it('keeps trust of user hooks and of events or earlier groups the cleanup did not touch', () => {
    const toml = [
      '[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:user-stop"',
      '',
      '[hooks.state."/home/u/.codex/hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:user-pre"',
      '',
    ].join('\n')

    expect(cleanLegacyCodexConfigToml(toml, new Map())).toEqual({ content: toml, removedCount: 0 })
    expect(cleanLegacyCodexConfigToml(toml, new Map([['pre_tool_use', 1]]))).toEqual({
      content: toml,
      removedCount: 0,
    })
  })

  it('derives stale trust from the first removed group so shifted indexes go too', () => {
    const user = { hooks: [{ type: 'command', command: 'user' }] }
    const legacy = { description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION, hooks: [] }
    const result = cleanLegacyCodexHooksFile({
      hooks: { PreToolUse: [user, legacy, user, user], Stop: [user] },
    })
    expect(result.staleTrust).toEqual(new Map([['pre_tool_use', 1]]))

    const toml = [0, 1, 2, 3]
      .map(
        n => `[hooks.state."/h/.codex/hooks.json:pre_tool_use:${n}:0"]\ntrusted_hash = "x${n}"\n`,
      )
      .concat('[hooks.state."/h/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "s"\n')
      .join('\n')
    const cleaned = cleanLegacyCodexConfigToml(toml, result.staleTrust)

    expect(cleaned.removedCount).toBe(3)
    expect(cleaned.content).toContain('pre_tool_use:0:0')
    expect(cleaned.content).not.toContain('pre_tool_use:1:0')
    expect(cleaned.content).not.toContain('pre_tool_use:3:0')
    expect(cleaned.content).toContain('stop:0:0')
  })

  it('marks every event of a whole-file removal as stale from group 0', () => {
    expect(collectWholeFileStaleTrust({ hooks: { SessionStart: [], Stop: [] } })).toEqual(
      new Map([
        ['session_start', 0],
        ['stop', 0],
      ]),
    )
  })
})
