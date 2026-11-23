import { createHash } from 'node:crypto'
import type {
  ApprovalDecision,
  ExecutorAttachInfo,
  ExecutorRuntime,
  ExecutorRuntimeEvent,
  ExecutorRuntimeListener,
  ExecutorServiceIdentity,
  ExecutorStartSpec,
  ExecutorTurnSnapshot,
  FindTurnResult,
} from '../../../../../src/contexts/orchestration/application/ports'

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class FakeRuntime implements ExecutorRuntime {
  public readonly listeners = new Set<ExecutorRuntimeListener>()
  public readonly startedTurns: { dispatchId: string; text: string }[] = []
  public readonly interrupts: (string | undefined)[] = []
  public readonly approvalAnswers: { requestId: string; decision: ApprovalDecision }[] = []
  public readonly closes: string[] = []
  public readonly findCalls: string[] = []
  public findResults = new Map<string, FindTurnResult>()
  public readResults = new Map<string, ExecutorTurnSnapshot>()
  public knownApprovals = new Set<string>()
  public startTurnError: (Error & { code: string }) | null = null
  public ensureSessionError: Error | null = null
  public identity: ExecutorServiceIdentity | null
  public identityError: Error | null = null
  public resumeRefs: (string | null)[] = []
  private turnCounter = 0

  public constructor(public readonly spec: ExecutorStartSpec) {
    this.identity = { pid: 4242, tokenSha256: sha256(`token-of-${spec.executorNodeId}`) }
  }

  public ensureSession = async (input: { resumeRef: string | null; fresh: boolean }) => {
    this.resumeRefs.push(input.resumeRef)
    if (this.ensureSessionError) {
      throw this.ensureSessionError
    }
    return {
      sessionRef: input.resumeRef ?? `session-of-${this.spec.executorNodeId}`,
      resumed: input.resumeRef !== null,
    }
  }
  public startTurn = async (input: { dispatchId: string; text: string }) => {
    if (this.startTurnError) {
      throw this.startTurnError
    }
    this.startedTurns.push(input)
    this.turnCounter += 1
    return { turnRef: `turn-${this.turnCounter}` }
  }
  public findTurnByDispatch = async (dispatchId: string) => {
    this.findCalls.push(dispatchId)
    return this.findResults.get(dispatchId) ?? ({ kind: 'unknown' } as const)
  }
  public readTurn = async (turnRef: string) => {
    const turn = this.readResults.get(turnRef)
    if (!turn) {
      throw new Error('unknown turn')
    }
    return turn
  }
  public respondApproval = async (requestId: string, decision: ApprovalDecision) => {
    this.approvalAnswers.push({ requestId, decision })
    return this.knownApprovals.has(requestId)
      ? ({ ok: true } as const)
      : ({ ok: false, reason: 'approval_not_found' } as const)
  }
  public interrupt = async (turnRef?: string) => {
    this.interrupts.push(turnRef)
  }
  public attachInfo = async (): Promise<ExecutorAttachInfo> => ({
    url: 'ws://127.0.0.1:1',
    tokenEnv: { name: 'OPENCOVE_EXECUTOR_REMOTE_TOKEN', value: 'secret' },
    sessionRef: `session-of-${this.spec.executorNodeId}`,
    cwd: this.spec.cwd,
  })
  public serviceIdentity = async (): Promise<ExecutorServiceIdentity | null> => {
    if (this.identityError) {
      throw this.identityError
    }
    return this.identity
  }
  public subscribe = (listener: ExecutorRuntimeListener) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  public close = async (reason: string) => {
    this.closes.push(reason)
  }

  public emit(event: ExecutorRuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event)
    }
  }
}
