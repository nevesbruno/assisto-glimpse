import { describe, expect, it } from 'vitest'
import {
  shouldAwaitRestoredAgentVisibleOutput,
  shouldGateRestoredAgentInput,
  shouldRequirePostGeometrySnapshotOutput,
} from '../../../src/contexts/workspace/presentation/renderer/components/terminalNode/useTerminalRuntimeSession.support'

describe('restored agent visibility policy', () => {
  it('gates agent input while the runtime is hydrating', () => {
    expect(
      shouldGateRestoredAgentInput({
        kind: 'agent',
        persistedSnapshot: '',
        agentResumeSessionIdVerified: false,
        agentLaunchMode: 'new',
      }),
    ).toBe(true)

    expect(
      shouldGateRestoredAgentInput({
        kind: 'terminal',
        persistedSnapshot: '',
        agentResumeSessionIdVerified: true,
        agentLaunchMode: 'resume',
      }),
    ).toBe(false)
  })

  it('awaits visible PTY output only for restored agent runtimes', () => {
    expect(
      shouldAwaitRestoredAgentVisibleOutput({
        kind: 'agent',
        agentResumeSessionIdVerified: true,
        agentLaunchMode: 'resume',
      }),
    ).toBe(true)

    expect(
      shouldAwaitRestoredAgentVisibleOutput({
        kind: 'agent',
        agentResumeSessionIdVerified: false,
        agentLaunchMode: 'resume',
      }),
    ).toBe(true)

    expect(
      shouldAwaitRestoredAgentVisibleOutput({
        kind: 'agent',
        agentResumeSessionIdVerified: false,
        agentLaunchMode: 'new',
      }),
    ).toBe(false)

    expect(
      shouldAwaitRestoredAgentVisibleOutput({
        kind: 'agent',
        agentResumeSessionIdVerified: true,
        agentLaunchMode: 'new',
      }),
    ).toBe(false)

    expect(
      shouldAwaitRestoredAgentVisibleOutput({
        kind: 'terminal',
        agentResumeSessionIdVerified: true,
        agentLaunchMode: 'resume',
      }),
    ).toBe(false)
  })

  it('requires a post-geometry meaningful snapshot only for restored cold agent hydration', () => {
    expect(
      shouldRequirePostGeometrySnapshotOutput({
        kind: 'agent',
        isLiveSessionReattach: false,
        agentResumeSessionIdVerified: true,
        agentLaunchMode: 'resume',
      }),
    ).toBe(true)

    expect(
      shouldRequirePostGeometrySnapshotOutput({
        kind: 'agent',
        isLiveSessionReattach: false,
        agentResumeSessionIdVerified: false,
        agentLaunchMode: 'resume',
      }),
    ).toBe(true)

    expect(
      shouldRequirePostGeometrySnapshotOutput({
        kind: 'agent',
        isLiveSessionReattach: true,
        agentResumeSessionIdVerified: true,
        agentLaunchMode: 'resume',
      }),
    ).toBe(false)

    expect(
      shouldRequirePostGeometrySnapshotOutput({
        kind: 'agent',
        isLiveSessionReattach: false,
        agentResumeSessionIdVerified: true,
        agentLaunchMode: 'new',
      }),
    ).toBe(false)

    expect(
      shouldRequirePostGeometrySnapshotOutput({
        kind: 'agent',
        isLiveSessionReattach: false,
        agentResumeSessionIdVerified: false,
        agentLaunchMode: 'new',
      }),
    ).toBe(false)

    expect(
      shouldRequirePostGeometrySnapshotOutput({
        kind: 'terminal',
        isLiveSessionReattach: false,
        agentResumeSessionIdVerified: true,
        agentLaunchMode: 'resume',
      }),
    ).toBe(false)
  })
})
