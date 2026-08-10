import { AUTH_INTERVAL_MS, LOGIN_CHECK, LOGOUT_CHECK, runAuthScenario, SESSION_CHECK } from './auth';
import {
  AUTH_CHECK,
  buildCrowdClient,
  checkAuth,
  checkReachable,
  pollRoundtrip,
  REACHABLE_CHECK,
  ROUNDTRIP_CHECK,
  submitRoundtrip,
} from './crowd';
import { type HttpProbeResult, probeHttp, SLOW_MS_DEFAULT } from './http';
import { acquireRunLock, getMeta, pruneHistory, releaseRunLock, saveCheck, upsertMeta } from './storage';
import type { CheckResult, Env } from './types';

export type CheckGroup = 'app' | 'auth' | 'crowd';

export interface CheckMeta {
  label: string;
  group: CheckGroup;
}

export const CHECK_META: Record<string, CheckMeta> = {
  'flaxia.web': { label: 'Flaxia Web', group: 'app' },
  'flaxia.api.timeline': { label: 'Timeline API', group: 'app' },
  'flaxia.api.games': { label: 'Games API', group: 'app' },
  'flaxia.api.nodeinfo': { label: 'NodeInfo (Federation)', group: 'app' },
  'flaxia.api.users': { label: 'Users API (D1)', group: 'app' },
  'flaxia.sandbox': { label: 'Sandbox', group: 'app' },
  [REACHABLE_CHECK]: { label: 'Orchestrator', group: 'crowd' },
  [AUTH_CHECK]: { label: 'API 認証', group: 'crowd' },
  [ROUNDTRIP_CHECK]: { label: '実タスク実行', group: 'crowd' },
  [LOGIN_CHECK]: { label: 'ログイン', group: 'auth' },
  [SESSION_CHECK]: { label: 'セッション (/api/me)', group: 'auth' },
  [LOGOUT_CHECK]: { label: 'ログアウト', group: 'auth' },
};

function httpErrorDetail(status: number): string {
  if (status >= 500) return `HTTP ${status}`;
  if (status >= 400) return `HTTP ${status} (期待する応答でない)`;
  return `HTTP ${status}`;
}

function httpResult(name: string, res: HttpProbeResult, slowMs: number): CheckResult {
  if (res.error) return { name, status: 'down', latencyMs: res.latencyMs, detail: '接続失敗', error: res.error };
  if (res.status >= 500)
    return { name, status: 'down', latencyMs: res.latencyMs, detail: httpErrorDetail(res.status), error: '' };
  if (res.status >= 400)
    return { name, status: 'degraded', latencyMs: res.latencyMs, detail: httpErrorDetail(res.status), error: '' };
  if (res.latencyMs > slowMs) {
    return { name, status: 'degraded', latencyMs: res.latencyMs, detail: `応答遅延 (${res.latencyMs}ms)`, error: '' };
  }
  return { name, status: 'operational', latencyMs: res.latencyMs, detail: '正常', error: '' };
}

export async function runChecks(env: Env): Promise<void> {
  if (!(await acquireRunLock(env))) return;
  const now = Date.now();
  try {
    const slowMs = Number(env.SLOW_MS) || SLOW_MS_DEFAULT;
    const base = env.BASE_URL;
    const sandbox = env.SANDBOX_URL;
    const results: CheckResult[] = [];

    // 1) HTTP-based checks
    const httpTargets: Array<{ name: string; url: string }> = [
      { name: 'flaxia.web', url: `${base}/` },
      { name: 'flaxia.api.timeline', url: `${base}/api/posts?limit=1` },
      { name: 'flaxia.api.games', url: `${base}/api/games?limit=1` },
      { name: 'flaxia.api.nodeinfo', url: `${base}/.well-known/nodeinfo` },
      { name: 'flaxia.api.users', url: `${base}/api/users/remydrescarlet` },
      { name: 'flaxia.sandbox', url: `${sandbox}/` },
    ];
    const httpResults = await Promise.all(
      httpTargets.map(async (t) => httpResult(t.name, await probeHttp(t.url, undefined, 10_000), slowMs)),
    );
    results.push(...httpResults);

    // 2) Crowd checks
    const crowdClient = buildCrowdClient(env);
    results.push(await checkReachable(env));
    results.push(await checkAuth(env));
    if (crowdClient) {
      const polled = await pollRoundtrip(env, crowdClient);
      const submitted = polled ? null : await submitRoundtrip(env, crowdClient);
      if (polled) results.push(polled);
      else if (submitted) results.push(submitted);
      // スロットル中 & 実行中なし → 前回結果を維持
    } else {
      results.push({
        name: ROUNDTRIP_CHECK,
        status: 'unknown',
        latencyMs: null,
        detail: 'CROWD_API_KEY 未設定',
        error: '',
      });
    }

    // 3) Auth scenario (throttled to avoid hammering the API)
    if (!env.STATUS_TEST_EMAIL || !env.STATUS_TEST_PASSWORD) {
      results.push({
        name: LOGIN_CHECK,
        status: 'unknown',
        latencyMs: null,
        detail: 'STATUS_TEST_* 未設定',
        error: '',
      });
      results.push({
        name: SESSION_CHECK,
        status: 'unknown',
        latencyMs: null,
        detail: 'STATUS_TEST_* 未設定',
        error: '',
      });
      results.push({
        name: LOGOUT_CHECK,
        status: 'unknown',
        latencyMs: null,
        detail: 'STATUS_TEST_* 未設定',
        error: '',
      });
    } else {
      const lastAuth = await getMeta(env, 'auth_last_run');
      if (!lastAuth || now - Number(lastAuth) >= AUTH_INTERVAL_MS) {
        results.push(...(await runAuthScenario(env)));
        await upsertMeta(env, 'auth_last_run', String(now));
      }
    }

    for (const r of results) {
      await saveCheck(env, r);
    }
    await pruneHistory(env, 90 * 24 * 60 * 60 * 1000);
  } catch (e) {
    console.error('status checks failed:', e);
  } finally {
    await releaseRunLock(env);
  }
}
