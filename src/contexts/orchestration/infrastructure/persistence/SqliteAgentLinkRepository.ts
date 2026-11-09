import type {
  AgentLinkRepository,
  CasResult,
  InsertLinkResult,
} from '../../application/ports/repositories'
import type { AgentLink } from '../../domain/agentLink'
import { ORCHESTRATION_LINKS_REVISION_KEY } from '../../../../platform/persistence/sqlite/orchestrationTables'
import { isUniqueViolation, type SqliteHandle } from './sqliteHandle'

type Row = Record<string, string | number | null>

const COLUMNS = [
  'id',
  'project_id',
  'space_id',
  'orchestrator_node_id',
  'executor_node_id',
  'kind',
  'origin',
  'runtime_mode',
  'provider',
  'state',
  'close_reason',
  'request_reason',
  'requested_at',
  'messages_limit',
  'messages_used_source',
  'messages_used_target',
  'spawn_request_id',
  'executor_session_ref',
  'service_pid',
  'service_token_sha256',
  'rounds_used',
  'rounds_limit',
  'created_at',
  'updated_at',
  'closed_at',
  'revision',
] as const

const COLUMN_LIST = COLUMNS.join(', ')
const PLACEHOLDERS = COLUMNS.map(() => '?').join(', ')
const ASSIGNMENTS = COLUMNS.filter(column => column !== 'id')
  .map(column => `${column} = ?`)
  .join(', ')

function toParams(link: AgentLink): (string | number | null)[] {
  return [
    link.id,
    link.projectId,
    link.spaceId,
    link.orchestratorNodeId,
    link.executorNodeId,
    link.kind,
    link.origin,
    link.runtimeMode,
    link.provider,
    link.state,
    link.closeReason,
    link.requestReason,
    link.requestedAt,
    link.messagesLimit,
    link.messagesUsedSource,
    link.messagesUsedTarget,
    link.spawnRequestId,
    link.executorSessionRef,
    link.servicePid,
    link.serviceTokenSha256,
    link.roundsUsed,
    link.roundsLimit,
    link.createdAt,
    link.updatedAt,
    link.closedAt,
    link.revision,
  ]
}

function toLink(row: Row): AgentLink {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    spaceId: row.space_id as string,
    orchestratorNodeId: row.orchestrator_node_id as string,
    executorNodeId: row.executor_node_id as string,
    kind: row.kind as AgentLink['kind'],
    origin: row.origin as AgentLink['origin'],
    runtimeMode: row.runtime_mode as AgentLink['runtimeMode'],
    provider: row.provider as string,
    state: row.state as AgentLink['state'],
    closeReason: row.close_reason as AgentLink['closeReason'],
    requestReason: row.request_reason as string | null,
    requestedAt: row.requested_at as string | null,
    messagesLimit: row.messages_limit as number,
    messagesUsedSource: row.messages_used_source as number,
    messagesUsedTarget: row.messages_used_target as number,
    spawnRequestId: row.spawn_request_id as string | null,
    executorSessionRef: row.executor_session_ref as string | null,
    servicePid: row.service_pid as number | null,
    serviceTokenSha256: row.service_token_sha256 as string | null,
    roundsUsed: row.rounds_used as number,
    roundsLimit: row.rounds_limit as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: row.closed_at as string | null,
    revision: row.revision as number,
  }
}

export class SqliteAgentLinkRepository implements AgentLinkRepository {
  public constructor(private readonly db: SqliteHandle) {}

  public async insert(link: AgentLink): Promise<InsertLinkResult> {
    try {
      this.inTransaction(() => {
        this.db
          .prepare(`INSERT INTO agent_links (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`)
          .run(...(toParams(link) as never[]))
        this.bumpLinksRevision()
      })
    } catch (error) {
      if (isUniqueViolation(error, 'agent_links.id')) {
        return { ok: false, reason: 'id_exists' }
      }
      if (isUniqueViolation(error, 'agent_links.spawn_request_id')) {
        return { ok: false, reason: 'spawn_request_duplicate' }
      }
      if (isUniqueViolation(error, 'agent_links.executor_node_id')) {
        return { ok: false, reason: 'executor_already_linked' }
      }
      throw error
    }
    return { ok: true, value: link }
  }

  public async update(next: AgentLink): Promise<CasResult<AgentLink>> {
    return this.inTransaction(() => {
      const [, ...assignedValues] = toParams(next)
      const { changes } = this.db
        .prepare(`UPDATE agent_links SET ${ASSIGNMENTS} WHERE id = ? AND revision = ?`)
        .run(...([...assignedValues, next.id, next.revision - 1] as never[]))
      if (Number(changes) === 1) {
        this.bumpLinksRevision()
        return { ok: true, value: next } as const
      }
      const exists = this.db.prepare('SELECT 1 FROM agent_links WHERE id = ?').get(next.id as never)
      return { ok: false, reason: exists ? 'revision_conflict' : 'not_found' } as const
    })
  }

  public async findById(linkId: string): Promise<AgentLink | null> {
    return this.one('id = ?', linkId)
  }

  public async findActiveByExecutor(executorNodeId: string): Promise<AgentLink | null> {
    return this.one("executor_node_id = ? AND state = 'active'", executorNodeId)
  }

  public async findBySpawnRequest(
    orchestratorNodeId: string,
    spawnRequestId: string,
  ): Promise<AgentLink | null> {
    return this.one(
      'orchestrator_node_id = ? AND spawn_request_id = ?',
      orchestratorNodeId,
      spawnRequestId,
    )
  }

  public async listActiveByOrchestrator(orchestratorNodeId: string): Promise<readonly AgentLink[]> {
    return this.many("orchestrator_node_id = ? AND state = 'active'", orchestratorNodeId)
  }

  public async listActive(): Promise<readonly AgentLink[]> {
    return this.many("state = 'active'")
  }

  /** `null` lists every project, as `orch.link.list` does without `projectId`. */
  public async listByProject(projectId: string | null): Promise<readonly AgentLink[]> {
    return projectId === null ? this.many('1 = 1') : this.many('project_id = ?', projectId)
  }

  public async readLinksRevision(): Promise<number> {
    const row = this.db
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(ORCHESTRATION_LINKS_REVISION_KEY as never) as { value: string } | undefined
    return row ? Number(row.value) : 0
  }

  private one(where: string, ...params: string[]): AgentLink | null {
    const row = this.db
      .prepare(`SELECT ${COLUMN_LIST} FROM agent_links WHERE ${where}`)
      .get(...(params as never[]))
    return row ? toLink(row as Row) : null
  }

  private many(where: string, ...params: string[]): AgentLink[] {
    return this.db
      .prepare(`SELECT ${COLUMN_LIST} FROM agent_links WHERE ${where} ORDER BY created_at, id`)
      .all(...(params as never[]))
      .map(row => toLink(row as Row))
  }

  private bumpLinksRevision(): void {
    this.db
      .prepare(`UPDATE app_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ?`)
      .run(ORCHESTRATION_LINKS_REVISION_KEY as never)
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
