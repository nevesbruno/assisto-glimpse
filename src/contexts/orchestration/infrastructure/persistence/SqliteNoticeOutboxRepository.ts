import type {
  EnqueueNoticeResult,
  NoticeDeliveryState,
  NoticeOutboxRepository,
  StoredNotice,
} from '../../application/ports/repositories'
import type { NoticeEntry } from '../../domain/noticeComposer'
import type { SqliteHandle } from './sqliteHandle'

type Row = Record<string, string | null>

function toNotice(row: Row): StoredNotice {
  return {
    id: row.id as string,
    orchestratorNodeId: row.orchestrator_node_id as string,
    dedupeKey: row.dedupe_key as string,
    entry: JSON.parse(row.payload_json as string) as NoticeEntry,
    state: row.delivery_state as NoticeDeliveryState,
    batchId: row.batch_id,
    createdAt: row.created_at as string,
    settledAt: row.delivered_at,
  }
}

export class SqliteNoticeOutboxRepository implements NoticeOutboxRepository {
  public constructor(private readonly db: SqliteHandle) {}

  public async enqueue(notice: StoredNotice): Promise<EnqueueNoticeResult> {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO orchestration_notices
          (id, orchestrator_node_id, executor_node_id, dispatch_id, kind, dedupe_key,
           payload_json, batch_id, delivery_state, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...([
          notice.id,
          notice.orchestratorNodeId,
          notice.entry.executorNodeId,
          notice.entry.dispatchId,
          notice.entry.kind,
          notice.dedupeKey,
          JSON.stringify(notice.entry),
          notice.batchId,
          notice.state,
          notice.createdAt,
          notice.settledAt,
        ] as never[]),
      )
    return { enqueued: Number(changes) === 1 }
  }

  public async listPending(orchestratorNodeId: string): Promise<readonly StoredNotice[]> {
    return this.list(orchestratorNodeId, 'pending')
  }

  public async listUncertain(orchestratorNodeId: string): Promise<readonly StoredNotice[]> {
    return this.list(orchestratorNodeId, 'uncertain')
  }

  public async settleBatch(
    noticeIds: readonly string[],
    batchId: string,
    state: Exclude<NoticeDeliveryState, 'pending'>,
    settledAt: Date,
  ): Promise<void> {
    if (noticeIds.length === 0) {
      return
    }
    const marks = noticeIds.map(() => '?').join(', ')
    this.db
      .prepare(
        `UPDATE orchestration_notices SET batch_id = ?, delivery_state = ?, delivered_at = ?
         WHERE id IN (${marks})`,
      )
      .run(...([batchId, state, settledAt.toISOString(), ...noticeIds] as never[]))
  }

  public async deleteByOrchestrator(orchestratorNodeId: string): Promise<void> {
    this.db
      .prepare('DELETE FROM orchestration_notices WHERE orchestrator_node_id = ?')
      .run(orchestratorNodeId as never)
  }

  private list(orchestratorNodeId: string, state: NoticeDeliveryState): StoredNotice[] {
    return this.db
      .prepare(
        `SELECT * FROM orchestration_notices
         WHERE orchestrator_node_id = ? AND delivery_state = ? ORDER BY created_at, id`,
      )
      .all(...([orchestratorNodeId, state] as never[]))
      .map(row => toNotice(row as Row))
  }
}
