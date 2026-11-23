import { describe, expect, it } from 'vitest'
import { AgentRunStateRegistry } from '../../../src/contexts/agent/application/AgentRunStateRegistry'
import { AgentRunStateRuntime } from '../../../src/contexts/agent/application/AgentRunStateRuntime'
import { promptAdmission } from '../../../src/contexts/agent/application/promptAdmission'
import { hookChannelFixture } from './claudeHookTranscript.helpers'
import { FakeTerminalProcessEngine } from '../../support/FakeTerminalProcessEngine'
import { createHeadlessPtyRuntime } from '../../../src/app/worker/headlessPtyRuntime'
import { PtyStreamHub } from '../../../src/app/main/controlSurface/ptyStream/ptyStreamHub'

const SESSION = 'orchestrator-session'

function fixture() {
  const registry = new AgentRunStateRegistry({
    epoch: 'worker',
    now: () => 100,
    createTurnId: () => 'turn',
    schedule: () => () => {},
  })
  const runtime = new AgentRunStateRuntime(registry, () => 100)
  return { registry, runtime }
}

/** What the managed launch publishes when the PTY is bound, before any hook arrives. */
function registerManagedLaunch(runtime: AgentRunStateRuntime): void {
  runtime.metadata({
    sessionId: SESSION,
    resumeSessionId: null,
    agentProvider: 'claude-code',
    agentLaunchKind: 'managed',
    hookCoverage: 'lifecycle',
    hookInstallState: 'installed',
  })
}

/** Shape of the hook channel identity metadata for a provider SessionStart. */
function sessionStartIdentity(runtime: AgentRunStateRuntime): void {
  runtime.metadata({ sessionId: SESSION, resumeSessionId: 'provider-thread' })
}

describe('run state after a crash restart (wave 6 R1)', () => {
  it('turns the provider SessionStart identity into authoritative idle without inventing a turn', () => {
    const { registry, runtime } = fixture()
    registerManagedLaunch(runtime)
    expect(registry.get({ sessionId: SESSION })).toMatchObject({ state: 'unknown' })

    sessionStartIdentity(runtime)

    expect(registry.get({ sessionId: SESSION })).toMatchObject({
      state: 'idle',
      quality: 'authoritative',
      source: 'claude_hook',
      turn: null,
      turnOutcome: null,
      lastEndedTurn: null,
    })
    const fence = registry.readFence({ sessionId: SESSION })!
    expect(fence.lastTurnEnd).toMatchObject({
      source: 'claude_hook',
      hookEventName: 'SessionStart',
    })
    expect(promptAdmission(fence, () => ({ supported: true, submitDelayMs: 300 }))).toBeNull()
  })

  it('ignores a bare identity without a registered provider', () => {
    const { registry, runtime } = fixture()
    sessionStartIdentity(runtime)
    expect(registry.get({ sessionId: SESSION })).toBeNull()
  })

  it('does not treat an invocation snapshot as SessionStart', () => {
    const { registry, runtime } = fixture()
    runtime.metadata({
      sessionId: SESSION,
      resumeSessionId: null,
      agentProvider: 'claude-code',
      terminalAgentActivity: {
        provider: 'claude-code',
        invocationId: 'invocation',
        generation: 1,
        phase: 'active',
        observedAtMs: 100,
        identityAuthority: null,
      },
    })
    expect(registry.get({ sessionId: SESSION })).toMatchObject({ state: 'unknown' })
  })

  it('carries the SessionStart identity through the real hook channel and PTY metadata', async () => {
    const engine = new FakeTerminalProcessEngine()
    const pty = createHeadlessPtyRuntime({ processEngine: engine })
    const hub = new PtyStreamHub({ ptyRuntime: pty, replayWindowMaxBytes: 64000 })
    const hook = await hookChannelFixture()
    const disposers = [
      pty.onMetadata(event => hub.registerSessionAgentMetadata(event)),
      pty.onState(event => hub.registerSessionAgentState(event)),
      hook.channel.onMetadata(event => hub.registerSessionAgentMetadata(event)),
      hook.channel.onState(event => hub.registerSessionAgentState(event)),
    ]
    try {
      const { sessionId } = await pty.spawnSession({
        cwd: '/tmp',
        command: 'claude',
        args: [],
        cols: 80,
        rows: 24,
        agentProvider: 'claude-code',
        hookCoverage: 'lifecycle',
        hookInstallState: 'installed',
      })
      hub.agentRuns.setBindings([{ sessionId, nodeId: 'node', projectId: 'p', remote: false }])
      hook.reservation.commit(sessionId)
      await hook.post(
        {
          session_id: 'provider',
          transcript_path: '/tmp/opencode/glimpse-onda6/tmp/missing-transcript.jsonl',
          cwd: '/',
          hook_event_name: 'SessionStart',
          source: 'resume',
        },
        1,
      )
      expect(hub.agentRuns.registry.get({ sessionId })).toMatchObject({
        state: 'idle',
        quality: 'authoritative',
        source: 'claude_hook',
        turn: null,
      })
    } finally {
      disposers.forEach(dispose => dispose())
      hub.agentRuns.dispose()
      pty.dispose()
      await hook.channel.dispose()
    }
  })
})
