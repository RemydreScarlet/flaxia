export type CheckStatus = 'operational' | 'degraded' | 'down' | 'unknown';

export type SparkStatus = 'ok' | 'slow' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  latencyMs: number | null;
  detail: string;
  /** 生のエラーメッセージ（UI には表示しない、履歴/デバッグ用） */
  error: string;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_URL: string;
  SANDBOX_URL: string;
  CROWD_ORCHESTRATOR_URL: string;
  STATUS_TEST_USERNAME?: string;
  CROWD_API_KEY?: string;
  STATUS_TEST_EMAIL?: string;
  STATUS_TEST_PASSWORD?: string;
  /** 閾値オーバーライド（ms）。未設定なら 4000ms */
  SLOW_MS?: string;
}

export interface CheckRow {
  name: string;
  status: CheckStatus;
  latency_ms: number | null;
  detail: string;
  error: string;
  histogram: string;
  checked_at: number;
  consecutive_failures: number;
  last_success_at: number | null;
  last_failure_at: number | null;
}

export interface IncidentRow {
  id: number;
  check_name: string;
  severity: string;
  started_at: number;
  resolved_at: number | null;
}
