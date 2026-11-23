import type {
  DispatchRepository,
  InsertDispatchResult,
  UpdateDispatchResult,
} from '../../application/ports/repositories'
import type { Dispatch, DispatchState } from '../../domain/dispatch'
import { isUniqueViolation, type SqliteHandle } from './sqliteHandle'

type Row = Record<string, string | number | null>

const COLUMNS = [
  'id',
  'link_id',
  'executor_node_id',
  'orchestrator_node_id',
  'round',
  'state',
  'reason',
  'text',
  'text_sha256',
  'text_bytes',
  'deadline_at',
  'turn_ref',
  'glimpse_turn_id',
  'outcome',
  'final_excerpt',
  'final_chars',
  'created_at',
  'reserved_at',
  'sent_at',
  'finished_at',
  'revision',
] as const

const COLUMN_LIST = COLUMNS.join(', ')
const PLACEHOLDERS = COLUMNS.map(() => '?').join(', ')
const ASSIGNMENTS = COLUMNS.filter(column => column !== 'id')
  .map(column => `${column} = ?`)
  .join(', ')
const IN_FLIGHT = "('reserved', 'sent', 'uncertain')"
const NON_FINAL = "('queued', 'reserved', 'sent', 'uncertain')"

function toParams(dispatch: Dispatch): (string | number | null)[] {
  return [
    dispatch.id,
    dispatch.linkId,
    dispatch.executorNodeId,
    dispatch.orchestratorNodeId,
    dispatch.round,
    dispatch.state,
    dispatch.reason,
    dispatch.text,
    dispatch.textSha256,
    dispatch.textBytes,
    dispatch.deadlineAt,
    dispatch.turnRef,
    dispatch.glimpseTurnId,
    dispatch.outcome,
    dispatch.finalExcerpt,
    dispatch.finalChars,
    dispatch.createdAt,
    dispatch.reservedAt,
    dispatch.sentAt,
    dispatch.finishedAt,
    dispatch.revision,
  ]
}

function toDispatch(row: Row): Dispatch {
  return {
    id: row.id as string,
    linkId: row.link_id as string,
    executorNodeId: row.executor_node_id as string,
    orchestratorNodeId: row.orchestrator_node_id as string,
    round: row.round as number,
    state: row.state as DispatchState,
    reason: row.reason as Dispatch['reason'],
    text: row.text as string | null,
    textSha256: row.text_sha256 as string,
    textBytes: row.text_bytes as number,
    deadlineAt: row.deadline_at as string,
    turnRef: row.turn_ref as string | null,
    glimpseTurnId: row.glimpse_turn_id as string | null,
    outcome: row.outcome as Dispatch['outcome'],
    finalExcerpt: row.final_excerpt as string | null,
    finalChars: row.final_chars as number | null,
    createdAt: row.created_at as string,
    reservedAt: row.reserved_at as string | null,
    sentAt: row.sent_at as string | null,
    finishedAt: row.finished_at as string | null,
    revision: row.revision as number,
  }
}

export function readDispatchRow(db: SqliteHandle, dispatchId: string): Dispatch | null {
  const row = db
    .prepare(`SELECT ${COLUMN_LIST} FROM orchestration_dispatches WHERE id = ?`)
    .get(dispatchId as never)
  return row ? toDispatch(row as Row) : null
}

export function findOpenDispatchRow(db: SqliteHandle, executorNodeId: string): Dispatch | null {
  const row = db
    .prepare(
      `SELECT ${COLUMN_LIST} FROM orchestration_dispatches
       WHERE executor_node_id = ? AND state IN ${NON_FINAL}`,
    )
    .get(executorNodeId as never)
  return row ? toDispatch(row as Row) : null
}

/** Another dispatch of the executor already holds the turn, which D1 allows to only one. */
export function hasOtherInFlightRow(db: SqliteHandle, dispatch: Dispatch): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM orchestration_dispatches
         WHERE executor_node_id = ? AND id <> ? AND state IN ${IN_FLIGHT}`,
      )
      .get(...([dispatch.executorNodeId, dispatch.id] as never[])) !== undefined
  )
}

export function insertDispatchRow(db: SqliteHandle, dispatch: Dispatch): void {
  db.prepare(`INSERT INTO orchestration_dispatches (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`).run(
    ...(toParams(dispatch) as never[]),
  )
}

/** Compare and swap by `revision`: the row changes only when it holds the previous one. */
export function casDispatchRow(
  db: SqliteHandle,
  next: Dispatch,
): 'ok' | 'revision_conflict' | 'not_found' {
  const [, ...assignedValues] = toParams(next)
  const { changes } = db
    .prepare(`UPDATE orchestration_dispatches SET ${ASSIGNMENTS} WHERE id = ? AND revision = ?`)
    .run(...([...assignedValues, next.id, next.revision - 1] as never[]))
  if (Number(changes) === 1) {
    return 'ok'
  }
  return readDispatchRow(db, next.id) ? 'revision_conflict' : 'not_found'
}

export class SqliteDispatchRepository implements DispatchRepository {
  public constructor(private readonly db: SqliteHandle) {}

  public async insert(dispatch: Dispatch): Promise<InsertDispatchResult> {
    if (readDispatchRow(this.db, dispatch.id)) {
      return { ok: false, reason: 'id_exists' }
    }
    try {
      insertDispatchRow(this.db, dispatch)
    } catch (error) {
      if (isUniqueViolation(error, 'orchestration_dispatches.executor_node_id')) {
        return { ok: false, reason: 'executor_busy' }
      }
      if (isUniqueViolation(error, 'orchestration_dispatches.id')) {
        return { ok: false, reason: 'id_exists' }
      }
      throw error
    }
    return { ok: true, value: dispatch }
  }

  public async update(next: Dispatch): Promise<UpdateDispatchResult> {
    if (next.state === 'reserved' && hasOtherInFlightRow(this.db, next)) {
      return { ok: false, reason: 'in_flight_conflict' }
    }
    const outcome = casDispatchRow(this.db, next)
    return outcome === 'ok' ? { ok: true, value: next } : { ok: false, reason: outcome }
  }

  public async findById(dispatchId: string): Promise<Dispatch | null> {
    return this.one('id = ?', dispatchId)
  }

  public async findInFlightByExecutor(executorNodeId: string): Promise<Dispatch | null> {
    return this.one(`executor_node_id = ? AND state IN ${IN_FLIGHT}`, executorNodeId)
  }

  public async findOldestQueuedByExecutor(executorNodeId: string): Promise<Dispatch | null> {
    return this.one("executor_node_id = ? AND state = 'queued'", executorNodeId)
  }

  public async findNonFinalByExecutor(executorNodeId: string): Promise<Dispatch | null> {
    return this.one(`executor_node_id = ? AND state IN ${NON_FINAL}`, executorNodeId)
  }

  public async listByLink(linkId: string): Promise<readonly Dispatch[]> {
    return this.many('link_id = ?', linkId)
  }

  public async listByStates(states: readonly DispatchState[]): Promise<readonly Dispatch[]> {
    if (states.length === 0) {
      return []
    }
    return this.many(`state IN (${states.map(() => '?').join(', ')})`, ...states)
  }

  private one(where: string, ...params: string[]): Dispatch | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMN_LIST} FROM orchestration_dispatches WHERE ${where} ORDER BY created_at, id LIMIT 1`,
      )
      .get(...(params as never[]))
    return row ? toDispatch(row as Row) : null
  }

  private many(where: string, ...params: string[]): Dispatch[] {
    return this.db
      .prepare(
        `SELECT ${COLUMN_LIST} FROM orchestration_dispatches WHERE ${where} ORDER BY created_at, id`,
      )
      .all(...(params as never[]))
      .map(row => toDispatch(row as Row))
  }
}
