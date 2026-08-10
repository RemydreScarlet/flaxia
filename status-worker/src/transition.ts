import type { CheckStatus, SparkStatus } from './types';

export interface TransitionResult {
  status: CheckStatus;
  consecutiveFailures: number;
  spark: SparkStatus | null;
}

/**
 * 連続失敗カウントに基づいて表示ステータスを決める。
 * - 成功時: consecutiveFailures = 0
 * - 単発の down は即座に down にせず degraded（確認中）として扱う
 * - downAfter 回連続で down になる
 */
export function applyConsecutiveFails(probe: CheckStatus, prevFailures: number, downAfter = 2): TransitionResult {
  switch (probe) {
    case 'operational':
      return { status: 'operational', consecutiveFailures: 0, spark: 'ok' };
    case 'degraded': {
      const fails = prevFailures + 1;
      return { status: 'degraded', consecutiveFailures: fails, spark: 'slow' };
    }
    case 'down': {
      const fails = prevFailures + 1;
      return {
        status: fails >= downAfter ? 'down' : 'degraded',
        consecutiveFailures: fails,
        spark: 'fail',
      };
    }
    default:
      // unknown: 判定を保留（進行中・設定なしなど）
      return { status: 'unknown', consecutiveFailures: prevFailures, spark: null };
  }
}

/** 最新を先頭にした sparkline ヒストグラムを作る（最大 max 件） */
export function nextHistogram(prev: SparkStatus[], spark: SparkStatus | null, max = 60): SparkStatus[] {
  if (!spark) return prev;
  const next = [spark, ...prev];
  return next.length > max ? next.slice(0, max) : next;
}

export function computeUptime(operational: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((operational / total) * 10_000) / 100;
}

export interface Bucket {
  time: number;
  uptime: number | null;
  sampleCount: number;
}

/** 履歴サンプルを stepMs 間隔のバケットにまとめ、バケットごとの稼働率(%)を返す */
export function bucketAvailability(
  samples: Array<{ checked_at: number; status: string }>,
  windowMs: number,
  stepMs: number,
  now = Date.now(),
): Bucket[] {
  const cutoff = now - windowMs;
  const buckets = new Map<number, { ok: number; total: number }>();
  for (const s of samples) {
    if (s.checked_at < cutoff) continue;
    const idx = Math.floor((s.checked_at - cutoff) / stepMs);
    const b = buckets.get(idx) ?? { ok: 0, total: 0 };
    b.total += 1;
    if (s.status === 'operational') b.ok += 1;
    buckets.set(idx, b);
  }
  const out: Bucket[] = [];
  const count = Math.floor(windowMs / stepMs);
  for (let i = 0; i < count; i++) {
    const b = buckets.get(i);
    out.push({
      time: cutoff + i * stepMs,
      uptime: b ? computeUptime(b.ok, b.total) : null,
      sampleCount: b?.total ?? 0,
    });
  }
  return out;
}
