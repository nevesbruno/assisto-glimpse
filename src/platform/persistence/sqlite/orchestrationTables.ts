import type Database from 'better-sqlite3'

export const ORCHESTRATION_LINKS_REVISION_KEY = 'orchestration_links_revision'

const ORCHESTRATION_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS agent_links (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    space_id TEXT,
    orchestrator_node_id TEXT NOT NULL,
    executor_node_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'executor',
    origin TEXT NOT NULL DEFAULT 'orchestrator_spawn',
    runtime_mode TEXT NOT NULL DEFAULT 'service',
    provider TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    close_reason TEXT,
    request_reason TEXT,
    requested_at TEXT,
    messages_limit INTEGER NOT NULL DEFAULT 5,
    messages_used_source INTEGER NOT NULL DEFAULT 0,
    messages_used_target INTEGER NOT NULL DEFAULT 0,
    spawn_request_id TEXT,
    executor_session_ref TEXT,
    service_pid INTEGER,
    service_token_sha256 TEXT,
    rounds_used INTEGER NOT NULL DEFAULT 0,
    rounds_limit INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orchestration_dispatches (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    executor_node_id TEXT NOT NULL,
    orchestrator_node_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    reason TEXT,
    text TEXT,
    text_sha256 TEXT NOT NULL,
    text_bytes INTEGER NOT NULL,
    deadline_at TEXT,
    turn_ref TEXT,
    glimpse_turn_id TEXT,
    outcome TEXT,
    final_excerpt TEXT,
    final_chars INTEGER,
    created_at TEXT NOT NULL,
    reserved_at TEXT,
    sent_at TEXT,
    finished_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orchestration_notices (
    id TEXT PRIMARY KEY,
    orchestrator_node_id TEXT NOT NULL,
    executor_node_id TEXT NOT NULL,
    dispatch_id TEXT,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    batch_id TEXT,
    delivery_state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS orchestration_hook_approvals (
    hook_key TEXT NOT NULL,
    current_hash TEXT NOT NULL,
    event_name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    PRIMARY KEY (hook_key, current_hash)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS agent_links_active_executor_unique_idx
    ON agent_links (executor_node_id) WHERE state = 'active';
  CREATE UNIQUE INDEX IF NOT EXISTS agent_links_spawn_request_unique_idx
    ON agent_links (orchestrator_node_id, spawn_request_id);
  CREATE INDEX IF NOT EXISTS agent_links_orchestrator_state_idx
    ON agent_links (orchestrator_node_id, state);
  CREATE UNIQUE INDEX IF NOT EXISTS orchestration_dispatches_in_flight_executor_unique_idx
    ON orchestration_dispatches (executor_node_id) WHERE state IN ('reserved', 'sent', 'uncertain');
  CREATE INDEX IF NOT EXISTS orchestration_dispatches_executor_state_created_idx
    ON orchestration_dispatches (executor_node_id, state, created_at);
  CREATE INDEX IF NOT EXISTS orchestration_dispatches_link_idx
    ON orchestration_dispatches (link_id);
  CREATE UNIQUE INDEX IF NOT EXISTS orchestration_notices_dedupe_key_unique_idx
    ON orchestration_notices (dedupe_key);
  CREATE INDEX IF NOT EXISTS orchestration_notices_pending_orchestrator_idx
    ON orchestration_notices (orchestrator_node_id) WHERE delivery_state = 'pending';

  INSERT OR IGNORE INTO app_meta (key, value) VALUES ('${ORCHESTRATION_LINKS_REVISION_KEY}', '0');
`

export function createOrchestrationTables(db: Database.Database): void {
  db.exec(ORCHESTRATION_TABLES_SQL)
}
