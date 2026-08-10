export const SLOW_MS_DEFAULT = 4000;

/** HTTP プローブ用の実測結果 */
export interface HttpProbeResult {
  status: number;
  latencyMs: number;
  error: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function probeHttp(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<HttpProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, latencyMs: Date.now() - started, error: '' };
  } catch (e) {
    return { status: 0, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 遅延を持たせて値で再試行する（crowd タスクのポーリング等） */
export { sleep };
