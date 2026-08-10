import { applyConsecutiveFails, nextHistogram } from './transition';
import type { CheckResult, CheckRow, Env, IncidentRow, SparkStatus } from './types';

/** 実行ロック。直近 ttlMs 以内に取得済みなら false（並列スケジュール実行を防ぐ） */
export async function acquireRunLock(env: Env, ttlMs = 90_000): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind('runner_lock')
    .first<{ value: string }>();
  if (row && now - Number(row.value) < ttlMs) return false;
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind('runner_lock', String(now))
    .run();
  return true;
}

export async function releaseRunLock(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM meta WHERE key = ?').bind('runner_lock').run();
}

export async function getMeta(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function upsertMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind(key, value)
    .run();
}

function mapRow(r: Record<string, unknown>): CheckRow {
  return {
    name: String(r.name),
    status: r.status as CheckRow['status'],
    latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
    detail: String(r.detail ?? ''),
    error: String(r.error ?? ''),
    histogram: String(r.histogram ?? '[]'),
    checked_at: Number(r.checked_at ?? 0),
    consecutive_failures: Number(r.consecutive_failures ?? 0),
    last_success_at: r.last_success_at == null ? null : Number(r.last_success_at),
    last_failure_at: r.last_failure_at == null ? null : Number(r.last_failure_at),
  };
}

export async function loadCheckRow(env: Env, name: string): Promise<CheckRow | null> {
  const row = await env.DB.prepare('SELECT * FROM checks WHERE name = ?').bind(name).first();
  return row ? mapRow(row) : null;
}

async function upsertCheckRow(env: Env, row: CheckRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO checks (name, status, latency_ms, detail, error, histogram, checked_at, consecutive_failures, last_success_at, last_failure_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       status = excluded.status,
       latency_ms = excluded.latency_ms,
       detail = excluded.detail,
       error = excluded.error,
       histogram = excluded.histogram,
       checked_at = excluded.checked_at,
       consecutive_failures = excluded.consecutive_failures,
       last_success_at = excluded.last_success_at,
       last_failure_at = excluded.last_failure_at`,
  )
    .bind(
      row.name,
      row.status,
      row.latency_ms,
      row.detail,
      row.error,
      row.histogram,
      row.checked_at,
      row.consecutive_failures,
      row.last_success_at,
      row.last_failure_at,
    )
    .run();
}

async function openIncident(env: Env, name: string, severity: string, at: number): Promise<void> {
  const open = await env.DB.prepare('SELECT id FROM incidents WHERE check_name = ? AND resolved_at IS NULL LIMIT 1')
    .bind(name)
    .first();
  if (open) return;
  await env.DB.prepare('INSERT INTO incidents (check_name, severity, started_at) VALUES (?, ?, ?)')
    .bind(name, severity, at)
    .run();
}

async function closeIncidents(env: Env, name: string, at: number): Promise<void> {
  await env.DB.prepare('UPDATE incidents SET resolved_at = ? WHERE check_name = ? AND resolved_at IS NULL')
    .bind(at, name)
    .run();
}

/**
 * チェック結果を saved。unknown はヒストグラム/連続失敗を変えず、状態表示だけ更新する。
 * operational ↔ degraded/down の遷移でインシデントをオープン/クローズする。
 */
export async function saveCheck(env: Env, result: CheckResult): Promise<void> {
  const now = Date.now();
  const prev = await loadCheckRow(env, result.name);
  const prevHistogram: SparkStatus[] = prev ? (JSON.parse(prev.histogram) as SparkStatus[]) : [];
  const transition = applyConsecutiveFails(result.status, prev?.consecutive_failures ?? 0);

  if (transition.status === 'unknown') {
    if (prev) {
      await upsertCheckRow(env, { ...prev, detail: result.detail, error: result.error, checked_at: now });
    } else {
      await upsertCheckRow(env, {
        name: result.name,
        status: 'unknown',
        latency_ms: result.latencyMs,
        detail: result.detail,
        error: result.error,
        histogram: '[]',
        checked_at: now,
        consecutive_failures: 0,
        last_success_at: null,
        last_failure_at: null,
      });
    }
    return;
  }

  const nowOk = transition.status === 'operational';
  // オープン中の incident が無いまま非 operational になったら開く（初回 degraded や不明→degraded も含む）
  if (!nowOk) await openIncident(env, result.name, transition.status, now);
  if (nowOk) await closeIncidents(env, result.name, now);

  const row: CheckRow = {
    name: result.name,
    status: transition.status,
    latency_ms: result.latencyMs,
    detail: result.detail,
    error: result.error,
    histogram: JSON.stringify(nextHistogram(prevHistogram, transition.spark)),
    checked_at: now,
    consecutive_failures: transition.consecutiveFailures,
    last_success_at: nowOk ? now : (prev?.last_success_at ?? null),
    last_failure_at: nowOk ? (prev?.last_failure_at ?? null) : now,
  };
  await upsertCheckRow(env, row);
  await env.DB.prepare('INSERT INTO history (check_name, status, latency_ms, checked_at) VALUES (?, ?, ?, ?)')
    .bind(result.name, transition.status, result.latencyMs, now)
    .run();
}

export async function pruneHistory(env: Env, retainMs: number): Promise<void> {
  await env.DB.prepare('DELETE FROM history WHERE checked_at < ?')
    .bind(Date.now() - retainMs)
    .run();
}

export async function getCheckStatuses(env: Env): Promise<CheckRow[]> {
  const rows = (await env.DB.prepare('SELECT * FROM checks ORDER BY name').all()).results;
  return rows.map(mapRow);
}

export async function getOpenIncidents(env: Env): Promise<IncidentRow[]> {
  const rows = (
    await env.DB.prepare(
      'SELECT id, check_name, severity, started_at, resolved_at FROM incidents WHERE resolved_at IS NULL ORDER BY started_at DESC',
    ).all()
  ).results;
  return rows.map((r) => ({
    id: Number(r.id),
    check_name: String(r.check_name),
    severity: String(r.severity),
    started_at: Number(r.started_at),
    resolved_at: r.resolved_at == null ? null : Number(r.resolved_at),
  }));
}

export interface UptimeSnapshot {
  okay: number;
  total: number;
  uptime: number | null;
}

export async function getUptime(env: Env, name: string, sinceMs: number): Promise<UptimeSnapshot> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS okay FROM history WHERE check_name = ? AND checked_at > ?',
  )
    .bind('operational', name, sinceMs)
    .first<{ total: number; okay: number | null }>();
  const total = Number(row?.total ?? 0);
  const okay = Number(row?.okay ?? 0);
  return { okay, total, uptime: total > 0 ? Math.round((okay / total) * 10_000) / 100 : null };
}

export async function loadHistorySamples(
  env: Env,
  name: string,
  sinceMs: number,
  limit = 10_000,
): Promise<Array<{ checked_at: number; status: string }>> {
  const rows = (
    await env.DB.prepare(
      'SELECT checked_at, status FROM history WHERE check_name = ? AND checked_at > ? ORDER BY checked_at ASC LIMIT ?',
    )
      .bind(name, sinceMs, limit)
      .all()
  ).results;
  return rows.map((r) => ({ checked_at: Number(r.checked_at), status: String(r.status) }));
}

// ---------------------------------------------------------------------------
// crowd タスク追跡
// ---------------------------------------------------------------------------

export async function savePendingTask(env: Env, taskId: string, workload: string, submittedAt: number): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO crowd_pending (task_id, workload, submitted_at) VALUES (?, ?, ?)')
    .bind(taskId, workload, submittedAt)
    .run();
}

export async function getInFlightTask(
  env: Env,
): Promise<{ task_id: string; workload: string; submitted_at: number } | null> {
  const row = await env.DB.prepare(
    'SELECT task_id, workload, submitted_at FROM crowd_pending ORDER BY submitted_at ASC LIMIT 1',
  ).first<{ task_id: string; workload: string; submitted_at: number }>();
  return row ?? null;
}

export async function deletePendingTask(env: Env, taskId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM crowd_pending WHERE task_id = ?').bind(taskId).run();
}
