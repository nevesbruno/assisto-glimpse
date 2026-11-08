import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupLegacyManagedHooksAtStartup } from '../../src/contexts/agent/infrastructure/cleanupLegacyManagedHooksAtStartup'
import {
  LEGACY_MANAGED_CLAUDE_HOOK_STATUS_MESSAGE,
  LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION,
} from '../../src/contexts/agent/infrastructure/legacyManagedHookCleanup'

const temporaryHomes: string[] = []

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(async path => await rm(path, { recursive: true })))
})

describe('legacy managed hook startup cleanup', () => {
  it('removes exact OpenCove residue while preserving 66 coexisting Orca groups', async () => {
    const home = await createTemporaryHome()
    const claudePath = join(home, '.claude', 'settings.json')
    const codexHooksPath = join(home, '.codex', 'hooks.json')
    const codexConfigPath = join(home, '.codex', 'config.toml')
    const orcaGroups = Array.from({ length: 66 }, (_, index) => ({
      description: `Orca agent hook ${String(index)}`,
      hooks: [{ type: 'command', command: `/opt/orca/hook-${String(index)}` }],
    }))
    const legacyClaudeGroup = {
      hooks: [
        {
          type: 'command',
          command: '/obsolete/opencove/claude-status.mjs',
          statusMessage: LEGACY_MANAGED_CLAUDE_HOOK_STATUS_MESSAGE,
        },
      ],
    }
    const claudeSettings = {
      theme: 'dark',
      permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [legacyClaudeGroup, ...orcaGroups],
        SessionEnd: [legacyClaudeGroup],
      },
    }
    const codexHooks = {
      description: 'Orca and user hooks',
      hooks: {
        SessionStart: [
          { description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION, hooks: [] },
          ...orcaGroups,
        ],
      },
    }
    const orcaTomlBlock = [
      '[hooks.state."/Users/test/.orca/hooks.json:session_start:0:0"]',
      'trusted_hash = "sha256:orca"',
      '',
    ].join('\n')
    const codexConfig = [
      'model = "user-model"',
      '',
      '[hooks.state."/Users/test/.codex/hooks.json:session_start:0:0"]',
      'trusted_hash = "sha256:obsolete-opencove"',
      '',
      orcaTomlBlock,
      '[projects."/workspace"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')
    await Promise.all([
      writeFile(claudePath, `${JSON.stringify(claudeSettings, null, 2)}\n`),
      writeFile(codexHooksPath, `${JSON.stringify(codexHooks, null, 2)}\n`),
      writeFile(codexConfigPath, codexConfig),
    ])
    const expectedOrcaBytes = Buffer.from(JSON.stringify(orcaGroups))

    const report = await cleanupLegacyManagedHooksAtStartup(home)

    expect(report.failures).toEqual([])
    expect(report.removedCount).toBe(4)
    const cleanedClaude = JSON.parse(await readFile(claudePath, 'utf8')) as typeof claudeSettings
    const cleanedCodex = JSON.parse(await readFile(codexHooksPath, 'utf8')) as typeof codexHooks
    expect(cleanedClaude).toMatchObject({
      theme: 'dark',
      permissions: { allow: ['Read'] },
    })
    expect(Buffer.from(JSON.stringify(cleanedClaude.hooks.PreToolUse))).toEqual(expectedOrcaBytes)
    expect(cleanedClaude.hooks).not.toHaveProperty('SessionEnd')
    expect(Buffer.from(JSON.stringify(cleanedCodex.hooks.SessionStart))).toEqual(expectedOrcaBytes)
    const cleanedToml = await readFile(codexConfigPath, 'utf8')
    expect(cleanedToml).not.toContain('obsolete-opencove')
    expect(cleanedToml).toContain(orcaTomlBlock)
    expect(cleanedToml).toContain('trust_level = "trusted"')

    const stableBytes = await Promise.all(
      [claudePath, codexHooksPath, codexConfigPath].map(async path => await readFile(path)),
    )
    await expect(cleanupLegacyManagedHooksAtStartup(home)).resolves.toEqual({
      removedCount: 0,
      failures: [],
    })
    await expect(
      Promise.all(
        [claudePath, codexHooksPath, codexConfigPath].map(async path => await readFile(path)),
      ),
    ).resolves.toEqual(stableBytes)
  })

  it('deletes a Codex hooks file marked as entirely OpenCove-owned', async () => {
    const home = await createTemporaryHome()
    const codexHooksPath = join(home, '.codex', 'hooks.json')
    await writeFile(
      codexHooksPath,
      JSON.stringify({ description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION, hooks: {} }),
    )

    await expect(cleanupLegacyManagedHooksAtStartup(home)).resolves.toEqual({
      removedCount: 1,
      failures: [],
    })
    await expect(access(codexHooksPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('legacy managed hook startup cleanup trust scoping', () => {
  const trust = (event: string, group: number, hash: string): string =>
    `[hooks.state."/h/.codex/hooks.json:${event}:${String(group)}:0"]\ntrusted_hash = "${hash}"\n`

  it('leaves config.toml untouched when hooks.json has no legacy hook', async () => {
    const home = await createTemporaryHome()
    const hooksPath = join(home, '.codex', 'hooks.json')
    const configPath = join(home, '.codex', 'config.toml')
    const config = `${trust('stop', 0, 'user')}\n${trust('pre_tool_use', 0, 'user2')}`
    await writeFile(
      hooksPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'mine' }] }] } }),
    )
    await writeFile(configPath, config)

    await expect(cleanupLegacyManagedHooksAtStartup(home)).resolves.toEqual({
      removedCount: 0,
      failures: [],
    })
    expect(await readFile(configPath, 'utf8')).toBe(config)
  })

  it('removes trust of the legacy group and of groups shifted after it, keeps the rest', async () => {
    const home = await createTemporaryHome()
    const hooksPath = join(home, '.codex', 'hooks.json')
    const configPath = join(home, '.codex', 'config.toml')
    const user = { hooks: [{ command: 'mine' }] }
    await writeFile(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [user],
          PreToolUse: [user, { description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION }, user],
        },
      }),
    )
    await writeFile(
      configPath,
      [
        trust('stop', 0, 'a'),
        trust('pre_tool_use', 0, 'b'),
        trust('pre_tool_use', 1, 'c'),
        trust('pre_tool_use', 2, 'd'),
      ].join('\n'),
    )

    const report = await cleanupLegacyManagedHooksAtStartup(home)

    expect(report).toEqual({ removedCount: 3, failures: [] })
    const cleaned = await readFile(configPath, 'utf8')
    expect(cleaned).toContain('"a"')
    expect(cleaned).toContain('"b"')
    expect(cleaned).not.toContain('"c"')
    expect(cleaned).not.toContain('"d"')
  })

  it('does nothing to config.toml when hooks.json is malformed', async () => {
    const home = await createTemporaryHome()
    const configPath = join(home, '.codex', 'config.toml')
    const config = trust('stop', 0, 'user')
    await writeFile(join(home, '.codex', 'hooks.json'), '{ broken')
    await writeFile(configPath, config)

    const report = await cleanupLegacyManagedHooksAtStartup(home)

    expect(report.failures).toHaveLength(1)
    expect(await readFile(configPath, 'utf8')).toBe(config)
  })

  it('leaves config.toml byte-identical when its TOML is malformed', async () => {
    const home = await createTemporaryHome()
    const configPath = join(home, '.codex', 'config.toml')
    const config = `${trust('stop', 0, 'x')}[broken\n`
    await writeFile(
      join(home, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION }] } }),
    )
    await writeFile(configPath, config)

    await cleanupLegacyManagedHooksAtStartup(home)

    expect(await readFile(configPath, 'utf8')).toBe(config)
  })

  it('runs once per installation: the marker blocks later executions', async () => {
    const home = await createTemporaryHome()
    const marker = join(home, 'userData', 'cleanup.done')
    const hooksPath = join(home, '.codex', 'hooks.json')
    const legacy = JSON.stringify({
      hooks: { Stop: [{ description: LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION }] },
    })
    await writeFile(hooksPath, legacy)

    await cleanupLegacyManagedHooksAtStartup(home, marker)
    await writeFile(hooksPath, legacy)
    const second = await cleanupLegacyManagedHooksAtStartup(home, marker)

    expect(second).toEqual({ removedCount: 0, failures: [] })
    expect(await readFile(hooksPath, 'utf8')).toBe(legacy)
  })

  it('does not write the marker when a step failed, so the next startup retries', async () => {
    const home = await createTemporaryHome()
    const marker = join(home, 'cleanup.done')
    await writeFile(join(home, '.codex', 'hooks.json'), '{ broken')

    await cleanupLegacyManagedHooksAtStartup(home, marker)

    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'opencove-legacy-hooks-'))
  temporaryHomes.push(home)
  await Promise.all([
    mkdir(join(home, '.claude'), { recursive: true }),
    mkdir(join(home, '.codex'), { recursive: true }),
  ])
  return home
}
