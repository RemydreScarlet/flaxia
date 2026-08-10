import type { CheckResult, Env } from './types';

export const LOGIN_CHECK = 'flaxia.auth.login';
export const SESSION_CHECK = 'flaxia.auth.session';
export const LOGOUT_CHECK = 'flaxia.auth.logout';

export const AUTH_INTERVAL_MS = 2 * 60 * 1000;

function extractSession(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /session=([^;\s,]+)/.exec(setCookie);
  return m ? m[1] : null;
}

function resultFromStatus(
  name: string,
  status: number,
  latencyMs: number,
  okDetail: string,
  errorPrefix: string,
): CheckResult {
  if (status === 200) return { name, status: 'operational', latencyMs, detail: okDetail, error: '' };
  if (status >= 500) return { name, status: 'down', latencyMs, detail: `${errorPrefix}: HTTP ${status}`, error: '' };
  if (status === 401)
    return { name, status: 'degraded', latencyMs, detail: `${errorPrefix}: 認証エラー (401)`, error: '' };
  return { name, status: 'degraded', latencyMs, detail: `${errorPrefix}: HTTP ${status}`, error: '' };
}

function disabledResult(name: string): CheckResult {
  return { name, status: 'unknown', latencyMs: null, detail: 'STATUS_TEST_* 未設定', error: '' };
}

/**
 * ログイン → /api/me（セッション確認） → ログアウト の一連フローを検証する。
 * 未設定の場合は unknown（無効化）を返す。
 */
export async function runAuthScenario(env: Env): Promise<CheckResult[]> {
  const email = env.STATUS_TEST_EMAIL;
  const password = env.STATUS_TEST_PASSWORD;
  const base = (env.BASE_URL ?? 'https://flaxia.app').replace(/\/+$/, '');
  if (!email || !password) {
    return [disabledResult(LOGIN_CHECK), disabledResult(SESSION_CHECK), disabledResult(LOGOUT_CHECK)];
  }

  // login
  const loginStarted = Date.now();
  let login: Response;
  try {
    login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return [
      { name: LOGIN_CHECK, status: 'down', latencyMs: Date.now() - loginStarted, detail: '接続失敗', error: message },
      { name: SESSION_CHECK, status: 'down', latencyMs: null, detail: 'ログイン不可のためスキップ', error: '' },
      { name: LOGOUT_CHECK, status: 'down', latencyMs: null, detail: 'ログイン不可のためスキップ', error: '' },
    ];
  }
  const loginLatency = Date.now() - loginStarted;
  const loginResult = resultFromStatus(LOGIN_CHECK, login.status, loginLatency, 'ログイン OK', 'ログイン失敗');

  if (login.status !== 200) {
    return [
      loginResult,
      { name: SESSION_CHECK, status: 'down', latencyMs: null, detail: 'ログイン不可のためスキップ', error: '' },
      { name: LOGOUT_CHECK, status: 'down', latencyMs: null, detail: 'ログイン不可のためスキップ', error: '' },
    ];
  }

  const token = extractSession(login.headers.get('set-cookie'));
  if (!token) {
    return [
      {
        name: LOGIN_CHECK,
        status: 'degraded',
        latencyMs: loginLatency,
        detail: 'ログイン OK だがセッション Cookie 不在',
        error: '',
      },
      { name: SESSION_CHECK, status: 'down', latencyMs: null, detail: 'Cookie 不在のためスキップ', error: '' },
      { name: LOGOUT_CHECK, status: 'down', latencyMs: null, detail: 'Cookie 不在のためスキップ', error: '' },
    ];
  }

  // /api/me with session cookie
  const meStarted = Date.now();
  let sessionResult: CheckResult;
  try {
    const me = await fetch(`${base}/api/me`, { headers: { Cookie: `session=${token}` } });
    const meLatency = Date.now() - meStarted;
    if (me.status === 200) {
      const body = (await me.json().catch(() => null)) as { user?: { username?: string } } | null;
      const expected = env.STATUS_TEST_USERNAME;
      if (expected && body?.user?.username !== expected) {
        sessionResult = {
          name: SESSION_CHECK,
          status: 'degraded',
          latencyMs: meLatency,
          detail: 'セッション有効だがユーザー不一致',
          error: '',
        };
      } else {
        sessionResult = {
          name: SESSION_CHECK,
          status: 'operational',
          latencyMs: meLatency,
          detail: 'セッション有効 OK',
          error: '',
        };
      }
    } else {
      sessionResult = resultFromStatus(SESSION_CHECK, me.status, meLatency, 'セッション有効 OK', 'セッション確認失敗');
    }
  } catch (e) {
    sessionResult = {
      name: SESSION_CHECK,
      status: 'down',
      latencyMs: Date.now() - meStarted,
      detail: '接続失敗',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // logout
  const logoutStarted = Date.now();
  let logoutResult: CheckResult;
  try {
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: `session=${token}` } });
    logoutResult = resultFromStatus(
      LOGOUT_CHECK,
      out.status,
      Date.now() - logoutStarted,
      'ログアウト OK',
      'ログアウト失敗',
    );
  } catch (e) {
    logoutResult = {
      name: LOGOUT_CHECK,
      status: 'down',
      latencyMs: Date.now() - logoutStarted,
      detail: '接続失敗',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  return [loginResult, sessionResult, logoutResult];
}
