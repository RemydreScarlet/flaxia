-- status.flaxia.app 用 D1 スキーマ
CREATE TABLE IF NOT EXISTS checks (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',
  latency_ms INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  histogram TEXT NOT NULL DEFAULT '[]',
  checked_at INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_name_time ON history(check_name, checked_at);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_name TEXT NOT NULL,
  severity TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(resolved_at);

CREATE TABLE IF NOT EXISTS crowd_pending (
  task_id TEXT PRIMARY KEY,
  workload TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);