import type {
  HookApproval,
  HookApprovalRepository,
  HookKeyHash,
} from '../../application/ports/repositories'
import type { SqliteHandle } from './sqliteHandle'

const PAIRS_PER_QUERY = 400

type Row = Record<string, string>

function toApproval(row: Row): HookApproval {
  return {
    key: row.hook_key,
    currentHash: row.current_hash,
    eventName: row.event_name,
    sourcePath: row.source_path,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
  }
}

export class SqliteHookApprovalRepository implements HookApprovalRepository {
  public constructor(private readonly db: SqliteHandle) {}

  public async record(approvals: readonly HookApproval[]): Promise<void> {
    if (approvals.length === 0) {
      return
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.db.prepare(
        `INSERT INTO orchestration_hook_approvals
          (hook_key, current_hash, event_name, source_path, approved_at, approved_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (hook_key, current_hash) DO NOTHING`,
      )
      for (const item of approvals) {
        insert.run(
          ...([
            item.key,
            item.currentHash,
            item.eventName,
            item.sourcePath,
            item.approvedAt,
            item.approvedBy,
          ] as never[]),
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  public async findApproved(pairs: readonly HookKeyHash[]): Promise<readonly HookApproval[]> {
    const found: HookApproval[] = []
    for (let start = 0; start < pairs.length; start += PAIRS_PER_QUERY) {
      const batch = pairs.slice(start, start + PAIRS_PER_QUERY)
      const values = batch.map(() => '(?, ?)').join(', ')
      const rows = this.db
        .prepare(
          `SELECT hook_key, current_hash, event_name, source_path, approved_at, approved_by
           FROM orchestration_hook_approvals
           WHERE (hook_key, current_hash) IN (VALUES ${values})`,
        )
        .all(...(batch.flatMap(pair => [pair.key, pair.currentHash]) as never[]))
      found.push(...rows.map(row => toApproval(row as Row)))
    }
    return found
  }
}
