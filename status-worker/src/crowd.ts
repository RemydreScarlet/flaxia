import { FlaxiaClient } from '@flaxia/sdk';
import { probeHttp } from './http';
import { deletePendingTask, getInFlightTask, getMeta, savePendingTask, upsertMeta } from './storage';
import type { CheckResult, Env } from './types';

export const REACHABLE_CHECK = 'flaxia.crowd.reachable';
export const AUTH_CHECK = 'flaxia.crowd.auth';
export const ROUNDTRIP_CHECK = 'flaxia.crowd.roundtrip';

export const ROUNDTRIP_THROTTLE_MS = 5 * 60 * 1000;
export const ROUNDTRIP_STALE_MS = 30 * 60 * 1000;

export function buildCrowdClient(env: Env): FlaxiaClient | null {
  const orchestrator = (env.CROWD_ORCHESTRATOR_URL ?? 'https://crowd.flaxia.app').replace(/\/+$/, '');
  const apiKey = env.CROWD_API_KEY;
  if (!apiKey) return null;
  return new FlaxiaClient({ apiKey, baseUrl: `${orchestrator}/crowd` });
}

/** オーケストレーター本体に到達できるか（任意の HTTP 応答 / 5xx=degraded / 接続失敗=down） */
export async function checkReachable(env: Env): Promise<CheckResult> {
  const base = (env.CROWD_ORCHESTRATOR_URL ?? 'https://crowd.flaxia.app').replace(/\/+$/, '');
  const res = await probeHttp(`${base}/`, undefined, 8000);
  if (res.error) {
    return { name: REACHABLE_CHECK, status: 'down', latencyMs: res.latencyMs, detail: '接続失敗', error: res.error };
  }
  if (res.status >= 500) {
    return {
      name: REACHABLE_CHECK,
      status: 'degraded',
      latencyMs: res.latencyMs,
      detail: `orchestrator 5xx (${res.status})`,
      error: '',
    };
  }
  return {
    name: REACHABLE_CHECK,
    status: 'operational',
    latencyMs: res.latencyMs,
    detail: `HTTP ${res.status}`,
    error: '',
  };
}

/** 無効な API キーが 401 (AuthenticationError) で拒否されることを検証する */
export async function checkAuth(env: Env): Promise<CheckResult> {
  const orchestrator = (env.CROWD_ORCHESTRATOR_URL ?? 'https://crowd.flaxia.app').replace(/\/+$/, '');
  const baseUrl = `${orchestrator}/crowd`;
  if (!env.CROWD_API_KEY) {
    return { name: AUTH_CHECK, status: 'unknown', latencyMs: null, detail: 'CROWD_API_KEY 未設定', error: '' };
  }
  const bad = new FlaxiaClient({ apiKey: 'fc_live_invalid_status_check', baseUrl });
  const started = Date.now();
  try {
    await bad.submit({
      workload: 'vector-embed',
      payload: { text: 'status' },
    });
    return {
      name: AUTH_CHECK,
      status: 'degraded',
      latencyMs: Date.now() - started,
      detail: '無効キーが受理された（認証不当）',
      error: '',
    };
  } catch (e) {
    const status = (e as { status?: number }).status;
    const latencyMs = Date.now() - started;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 401)
      return { name: AUTH_CHECK, status: 'operational', latencyMs, detail: '認証拒否 OK (401)', error: '' };
    if (status === undefined) {
      return { name: AUTH_CHECK, status: 'down', latencyMs, detail: 'orchestrator に到達不能', error: message };
    }
    return { name: AUTH_CHECK, status: 'degraded', latencyMs, detail: `予期しない応答 (${status})`, error: message };
  }
}

/**
 * 進行中の roundtrip タスクを検証する。
 * - done/有効 → operational
 * - done/不正 → degraded
 * - failed      → down
 * - 滞留 (>stale) → degraded、タスク削除
 * - 実行中       → unknown（進行中として表示、履歴には記録しない）
 */
export async function pollRoundtrip(env: Env, client: FlaxiaClient): Promise<CheckResult | null> {
  const task = await getInFlightTask(env);
  if (!task) return null;
  const now = Date.now();
  const started = Date.now();
  let record: { status: string; error?: string; result?: unknown };
  try {
    record = await client.getTask(task.task_id);
  } catch (e) {
    const status = (e as { status?: number }).status;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 404 || status === undefined) {
      await deletePendingTask(env, task.task_id);
      return {
        name: ROUNDTRIP_CHECK,
        status: 'degraded',
        latencyMs: Date.now() - started,
        detail: 'タスクが消失 (not found)',
        error: message,
      };
    }
    return {
      name: ROUNDTRIP_CHECK,
      status: 'unknown',
      latencyMs: Date.now() - started,
      detail: `orchestrator 応答失敗（次回再検証）`,
      error: message,
    };
  }
  const latencyMs = Date.now() - started;
  const age = now - task.submitted_at;

  if (record.status === 'done') {
    await deletePendingTask(env, task.task_id);
    // vector-embed の結果は flaxia 本番と同じ形状: { output: { vector, model, dimensions } }
    const resultObj = record.result as Record<string, unknown> | undefined;
    const output = (resultObj?.output ?? resultObj) as Record<string, unknown> | undefined;
    const ok = !!output && Array.isArray(output.vector) && (output.vector as unknown[]).length > 0;
    return {
      name: ROUNDTRIP_CHECK,
      status: ok ? 'operational' : 'degraded',
      latencyMs,
      detail: ok ? 'タスク完了 OK' : 'タスク完了だが結果が不正',
      error: '',
    };
  }
  if (record.status === 'failed') {
    await deletePendingTask(env, task.task_id);
    return { name: ROUNDTRIP_CHECK, status: 'down', latencyMs, detail: `タスク失敗`, error: record.error ?? '' };
  }
  if (age > ROUNDTRIP_STALE_MS) {
    await deletePendingTask(env, task.task_id);
    return {
      name: ROUNDTRIP_CHECK,
      status: 'degraded',
      latencyMs,
      detail: 'タスクが滞留（ノード不足/キュー停滞）',
      error: '',
    };
  }
  return { name: ROUNDTRIP_CHECK, status: 'unknown', latencyMs, detail: `実行中 (${record.status})`, error: '' };
}

/**
 * 新しい実タスクを submit する。前回から ROUNDTRIP_THROTTLE_MS 経過かつ
 * 実行中のタスクが無い場合のみ。スキップ時は null を返す（状態は前回を維持）。
 */
export async function submitRoundtrip(env: Env, client: FlaxiaClient): Promise<CheckResult | null> {
  const now = Date.now();
  const last = await getMeta(env, 'crowd_last_submit');
  if (last && now - Number(last) < ROUNDTRIP_THROTTLE_MS) return null;
  const inflight = await getInFlightTask(env);
  if (inflight) return null;
  const started = Date.now();
  try {
    // flaxia 本体 (embedPost) と同一のペイロードで submit する
    const res = await client.submit({
      workload: 'vector-embed',
      payload: { text: 'Is the Flaxia crowd network operational?' },
      timeoutMs: 600_000,
    });
    await savePendingTask(env, res.id, 'vector-embed', now);
    await upsertMeta(env, 'crowd_last_submit', String(now));
    return {
      name: ROUNDTRIP_CHECK,
      status: 'unknown',
      latencyMs: Date.now() - started,
      detail: 'タスク投入 OK → 検証待ち',
      error: '',
    };
  } catch (e) {
    const status = (e as { status?: number }).status;
    const message = e instanceof Error ? e.message : String(e);
    return {
      name: ROUNDTRIP_CHECK,
      status: status === undefined ? 'down' : 'degraded',
      latencyMs: Date.now() - started,
      detail: `タスク投入失敗 (${status ?? 'network'})`,
      error: message,
    };
  }
}
