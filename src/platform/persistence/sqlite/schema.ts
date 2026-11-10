import {
  integer,
  real,
  sqliteTable,
  text,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export type DbAppMetaKey =
  | 'format_version'
  | 'active_workspace_id'
  | 'app_state_revision'
  | 'canvas_collapse_state'
  | 'orchestration_links_revision'
  | 'orchestration_links_mirror'

export const appMeta = sqliteTable('app_meta', {
  key: text('key').$type<DbAppMetaKey>().primaryKey(),
  value: text('value').notNull(),
})

export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey(),
  value: text('value').notNull(),
})

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  iconId: text('icon_id'),
  path: text('path').notNull(),
  worktreesRoot: text('worktrees_root').notNull(),
  pullRequestBaseBranchOptionsJson: text('pull_request_base_branch_options_json').notNull(),
  environmentVariablesJson: text('environment_variables_json').notNull(),
  spaceArchiveRecordsJson: text('space_archive_records_json').notNull(),
  viewportX: real('viewport_x').notNull(),
  viewportY: real('viewport_y').notNull(),
  viewportZoom: real('viewport_zoom').notNull(),
  isMinimapVisible: integer('is_minimap_visible', { mode: 'boolean' }).notNull(),
  activeSpaceId: text('active_space_id'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  sessionId: text('session_id'),
  title: text('title').notNull(),
  titlePinnedByUser: integer('title_pinned_by_user', { mode: 'number' }).notNull(),
  positionX: real('position_x').notNull(),
  positionY: real('position_y').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  kind: text('kind').notNull(),
  profileId: text('profile_id'),
  runtimeKind: text('runtime_kind'),
  terminalGeometryJson: text('terminal_geometry_json'),
  workerBindingJson: text('worker_binding_json'),
  terminalProviderHint: text('terminal_provider_hint'),
  labelColorOverride: text('label_color_override'),
  sidebarSortOrder: integer('sidebar_sort_order'),
  status: text('status'),
  startedAt: text('started_at'),
  endedAt: text('ended_at'),
  exitCode: integer('exit_code'),
  lastError: text('last_error'),
  executionDirectory: text('execution_directory'),
  expectedDirectory: text('expected_directory'),
  agentJson: text('agent_json'),
  taskJson: text('task_json'),
})

export const spaces = sqliteTable('workspace_spaces', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name: text('name').notNull(),
  directoryPath: text('directory_path').notNull(),
  targetMountId: text('target_mount_id'),
  parentSpaceId: text('parent_space_id'),
  boundaryJson: text('boundary_json').notNull().default('{}'),
  sortOrder: integer('sort_order').notNull().default(0),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  labelColor: text('label_color'),
  rectX: real('rect_x'),
  rectY: real('rect_y'),
  rectWidth: real('rect_width'),
  rectHeight: real('rect_height'),
})

export const spaceNodes = sqliteTable(
  'workspace_space_nodes',
  {
    spaceId: text('space_id').notNull(),
    nodeId: text('node_id').notNull(),
    sortOrder: integer('sort_order').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.spaceId, table.nodeId] }),
  }),
)

export const nodeScrollback = sqliteTable('node_scrollback', {
  nodeId: text('node_id').primaryKey(),
  scrollback: text('scrollback').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const terminalRecoveryRecords = sqliteTable('terminal_recovery_records', {
  nodeId: text('node_id').primaryKey(),
  formatVersion: integer('format_version').notNull(),
  generation: integer('generation').notNull(),
  bindingJson: text('binding_json'),
  runtimeEpoch: text('runtime_epoch'),
  checkpointRevision: integer('checkpoint_revision').notNull().default(0),
  appliedSeq: integer('applied_seq').notNull().default(0),
  presentationJson: text('presentation_json'),
  rawTail: text('raw_tail').notNull().default(''),
  rawTruncated: integer('raw_truncated', { mode: 'boolean' }).notNull().default(false),
  checksum: text('checksum'),
  updatedAt: text('updated_at').notNull(),
})

export const agentNodePlaceholderScrollback = sqliteTable('agent_node_placeholder_scrollback', {
  nodeId: text('node_id').primaryKey(),
  scrollback: text('scrollback').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 会话目录扫描结果的持久化缓存。以会话文件路径为键,mtime+size 为指纹;
// 命中(指纹一致)即复用,免去重新扫描会话日志。value_json 存各 provider 解析出的
// 结果(形状各异:Claude 是 {title,preview}、Codex 是预览串、Gemini 是整条摘要),
// 故用通用 JSON blob 而非固定列。仅缓存需扫描文件的来源(claude-code / codex /
// gemini),OpenCode 自带标题不入此表。
export const agentSessionTitleCache = sqliteTable('agent_session_title_cache', {
  filePath: text('file_path').primaryKey(),
  provider: text('provider').notNull(),
  mtimeMs: real('mtime_ms').notNull(),
  size: integer('size').notNull(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const browserProfileSettings = sqliteTable('browser_profile_settings', {
  profileKey: text('profile_key').primaryKey(),
  homepageUrl: text('homepage_url'),
  updatedAt: text('updated_at').notNull(),
})

export const browserHistory = sqliteTable(
  'browser_history',
  {
    id: text('id').primaryKey(),
    profileKey: text('profile_key').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    faviconUrl: text('favicon_url'),
    visitCount: integer('visit_count').notNull(),
    lastVisitedAt: text('last_visited_at').notNull(),
  },
  table => ({
    profileVisitedIdx: index('browser_history_profile_visited_idx').on(
      table.profileKey,
      table.lastVisitedAt,
    ),
    profileUrlIdx: uniqueIndex('browser_history_profile_url_unique_idx').on(
      table.profileKey,
      table.url,
    ),
  }),
)

export const browserBookmarks = sqliteTable(
  'browser_bookmarks',
  {
    id: text('id').primaryKey(),
    profileKey: text('profile_key').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    faviconUrl: text('favicon_url'),
    folderId: text('folder_id'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  table => ({
    profileUpdatedIdx: index('browser_bookmarks_profile_updated_idx').on(
      table.profileKey,
      table.updatedAt,
    ),
    profileUrlIdx: uniqueIndex('browser_bookmarks_profile_url_unique_idx').on(
      table.profileKey,
      table.url,
    ),
  }),
)

export const browserDownloads = sqliteTable(
  'browser_downloads',
  {
    id: text('id').primaryKey(),
    profileKey: text('profile_key').notNull(),
    url: text('url').notNull(),
    filename: text('filename').notNull(),
    savePath: text('save_path'),
    state: text('state').notNull(),
    receivedBytes: integer('received_bytes').notNull(),
    totalBytes: integer('total_bytes'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    error: text('error'),
  },
  table => ({
    profileStartedIdx: index('browser_downloads_profile_started_idx').on(
      table.profileKey,
      table.startedAt,
    ),
  }),
)

export const browserPermissionDecisions = sqliteTable(
  'browser_permission_decisions',
  {
    id: text('id').primaryKey(),
    profileKey: text('profile_key').notNull(),
    origin: text('origin').notNull(),
    permission: text('permission').notNull(),
    decision: text('decision').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  table => ({
    profileOriginPermissionIdx: uniqueIndex(
      'browser_permissions_profile_origin_permission_unique_idx',
    ).on(table.profileKey, table.origin, table.permission),
  }),
)

export const agentLinks = sqliteTable(
  'agent_links',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    spaceId: text('space_id').notNull(),
    orchestratorNodeId: text('orchestrator_node_id').notNull(),
    executorNodeId: text('executor_node_id').notNull(),
    kind: text('kind').notNull().default('executor'),
    origin: text('origin').notNull().default('orchestrator_spawn'),
    runtimeMode: text('runtime_mode').notNull().default('service'),
    provider: text('provider').notNull(),
    state: text('state').notNull().default('active'),
    closeReason: text('close_reason'),
    requestReason: text('request_reason'),
    requestedAt: text('requested_at'),
    messagesLimit: integer('messages_limit').notNull().default(5),
    messagesUsedSource: integer('messages_used_source').notNull().default(0),
    messagesUsedTarget: integer('messages_used_target').notNull().default(0),
    spawnRequestId: text('spawn_request_id'),
    executorSessionRef: text('executor_session_ref'),
    servicePid: integer('service_pid'),
    serviceTokenSha256: text('service_token_sha256'),
    roundsUsed: integer('rounds_used').notNull().default(0),
    roundsLimit: integer('rounds_limit').notNull().default(3),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    closedAt: text('closed_at'),
    revision: integer('revision').notNull().default(1),
  },
  table => ({
    activeExecutorIdx: uniqueIndex('agent_links_active_executor_unique_idx')
      .on(table.executorNodeId)
      .where(sql`state = 'active'`),
    spawnRequestIdx: uniqueIndex('agent_links_spawn_request_unique_idx').on(
      table.orchestratorNodeId,
      table.spawnRequestId,
    ),
    orchestratorStateIdx: index('agent_links_orchestrator_state_idx').on(
      table.orchestratorNodeId,
      table.state,
    ),
  }),
)

export const orchestrationDispatches = sqliteTable(
  'orchestration_dispatches',
  {
    id: text('id').primaryKey(),
    linkId: text('link_id').notNull(),
    executorNodeId: text('executor_node_id').notNull(),
    orchestratorNodeId: text('orchestrator_node_id').notNull(),
    round: integer('round').notNull(),
    state: text('state').notNull().default('queued'),
    reason: text('reason'),
    text: text('text'),
    textSha256: text('text_sha256').notNull(),
    textBytes: integer('text_bytes').notNull(),
    deadlineAt: text('deadline_at').notNull(),
    turnRef: text('turn_ref'),
    glimpseTurnId: text('glimpse_turn_id'),
    outcome: text('outcome'),
    finalExcerpt: text('final_excerpt'),
    finalChars: integer('final_chars'),
    createdAt: text('created_at').notNull(),
    reservedAt: text('reserved_at'),
    sentAt: text('sent_at'),
    finishedAt: text('finished_at'),
    revision: integer('revision').notNull().default(1),
  },
  table => ({
    openExecutorIdx: uniqueIndex('orchestration_dispatches_open_executor_unique_idx')
      .on(table.executorNodeId)
      .where(sql`state IN ('queued', 'reserved', 'sent', 'uncertain')`),
    executorStateCreatedIdx: index('orchestration_dispatches_executor_state_created_idx').on(
      table.executorNodeId,
      table.state,
      table.createdAt,
    ),
    linkIdx: index('orchestration_dispatches_link_idx').on(table.linkId),
  }),
)

export const orchestrationNotices = sqliteTable(
  'orchestration_notices',
  {
    id: text('id').primaryKey(),
    orchestratorNodeId: text('orchestrator_node_id').notNull(),
    executorNodeId: text('executor_node_id').notNull(),
    dispatchId: text('dispatch_id'),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payloadJson: text('payload_json').notNull(),
    batchId: text('batch_id'),
    deliveryState: text('delivery_state').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
    deliveredAt: text('delivered_at'),
  },
  table => ({
    dedupeKeyIdx: uniqueIndex('orchestration_notices_dedupe_key_unique_idx').on(table.dedupeKey),
    pendingOrchestratorIdx: index('orchestration_notices_pending_orchestrator_idx')
      .on(table.orchestratorNodeId)
      .where(sql`delivery_state = 'pending'`),
  }),
)

export const orchestrationHookApprovals = sqliteTable(
  'orchestration_hook_approvals',
  {
    hookKey: text('hook_key').notNull(),
    currentHash: text('current_hash').notNull(),
    eventName: text('event_name').notNull(),
    sourcePath: text('source_path').notNull(),
    approvedAt: text('approved_at').notNull(),
    approvedBy: text('approved_by').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.hookKey, table.currentHash] }),
  }),
)
