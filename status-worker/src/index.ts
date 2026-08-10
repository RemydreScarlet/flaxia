import { CHECK_META, runChecks } from './checks';
import { getCheckStatuses, getOpenIncidents, getUptime, loadHistorySamples } from './storage';
import { bucketAvailability } from './transition';
import type { Env } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

function securityHeaders(headers = new Headers()): Headers {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
  );
  return headers;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign(securityHeaders(), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }),
  });
}

function truncateDetail(detail: string, max = 120): string {
  return detail.length > max ? `${detail.slice(0, max)}…` : detail;
}

async function statusJson(env: Env): Promise<Response> {
  const rows = await getCheckStatuses(env);
  const incidents = await getOpenIncidents(env);
  const incidentByCheck = new Map(incidents.map((i) => [i.check_name, i]));
  const lastRunAt = rows.reduce((m, r) => Math.max(m, r.checked_at), 0);

  let overall: string = 'operational';
  for (const r of rows) {
    if (r.status === 'down') {
      overall = 'down';
      break;
    }
    if (r.status === 'degraded' && overall === 'operational') overall = 'degraded';
  }

  const now = Date.now();
  const checks = [];
  for (const r of rows) {
    const [u7, u30, u90] = await Promise.all([
      getUptime(env, r.name, now - 7 * DAY_MS),
      getUptime(env, r.name, now - 30 * DAY_MS),
      getUptime(env, r.name, now - 90 * DAY_MS),
    ]);
    checks.push({
      name: r.name,
      label: CHECK_META[r.name]?.label ?? r.name,
      group: CHECK_META[r.name]?.group ?? 'app',
      status: r.status,
      latencyMs: r.latency_ms,
      checkedAt: r.checked_at,
      detail: truncateDetail(r.detail),
      consecutiveFailures: r.consecutive_failures,
      lastSuccessAt: r.last_success_at,
      lastFailureAt: r.last_failure_at,
      uptime: { d7: u7.uptime, d30: u30.uptime, d90: u90.uptime },
      sparkline: JSON.parse(r.histogram) as string[],
      incident: incidentByCheck.get(r.name)
        ? {
            severity: incidentByCheck.get(r.name)?.severity,
            startedAt: incidentByCheck.get(r.name)?.started_at,
          }
        : null,
    });
  }

  return json({
    asOf: Date.now(),
    lastRunAt,
    overall,
    checks,
    incidents: incidents.map((i) => ({
      checkName: i.check_name,
      severity: i.severity,
      startedAt: i.started_at,
    })),
  });
}

async function historyJson(env: Env, url: URL): Promise<Response> {
  const check = url.searchParams.get('check');
  const rawDays = Number(url.searchParams.get('days') ?? '7');
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.round(rawDays), 1), 90) : 7;
  if (!check || !CHECK_META[check]) {
    return json({ error: 'check パラメータが不正です', validChecks: Object.keys(CHECK_META) }, 400);
  }
  const now = Date.now();
  const windowMs = days * DAY_MS;
  const stepMs = days <= 1 ? 5 * 60 * 1000 : days <= 7 ? 30 * 60 * 1000 : 3 * 60 * 60 * 1000;
  const samples = await loadHistorySamples(env, check, now - windowMs);
  const buckets = bucketAvailability(samples, windowMs, stepMs, now);
  return json({ check, days, windowMs, stepMs, totalSamples: samples.length, buckets });
}

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await runChecks(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/status') return statusJson(env);
      if (pathname === '/api/history') return historyJson(env, url);
      return json({ error: 'Not Found' }, 404);
    }

    // static assets (index.html / styles.css / app.js / robots.txt)
    const assetRes = await env.ASSETS.fetch(request);
    if (assetRes.status !== 404) return assetRes;

    // SPA fallback for navigations
    if (request.method === 'GET') {
      const indexRes = await env.ASSETS.fetch(new Request(new URL('/', url), request));
      return indexRes.status === 404 ? new Response('Not Found', { status: 404 }) : indexRes;
    }
    return new Response('Not Found', { status: 404 });
  },
};
