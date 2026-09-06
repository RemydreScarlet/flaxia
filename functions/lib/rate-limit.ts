/**
 * KV-based rate limiter for media endpoints and global API.
 *
 * Uses Cloudflare KV to track request counts per IP or user ID.
 * Falls through (allows request) if KV is unavailable.
 */

export interface RateLimitConfig {
  /** Maximum requests allowed within the window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 100,
  windowSeconds: 60,
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetSeconds: number;
  key: string;
}

/**
 * Check rate limit for a given key and return detailed info.
 */
export async function checkRateLimitWithInfo(
  kv: KVNamespace | undefined,
  key: string,
  config: RateLimitConfig = DEFAULT_CONFIG,
): Promise<{ allowed: boolean; remaining: number; limit: number; resetSeconds: number }> {
  if (!kv) {
    return {
      allowed: true,
      remaining: config.maxRequests,
      limit: config.maxRequests,
      resetSeconds: config.windowSeconds,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const windowNumber = Math.floor(now / config.windowSeconds);
  const windowKey = `rl:${key}:${windowNumber}`;
  const resetSeconds = config.windowSeconds - (now % config.windowSeconds);

  try {
    const current = await kv.get(windowKey);
    const count = current ? Number.parseInt(current, 10) : 0;

    if (count >= config.maxRequests) {
      return { allowed: false, remaining: 0, limit: config.maxRequests, resetSeconds };
    }

    await kv.put(windowKey, String(count + 1), {
      expirationTtl: config.windowSeconds * 2,
    });

    return { allowed: true, remaining: config.maxRequests - count - 1, limit: config.maxRequests, resetSeconds };
  } catch {
    return { allowed: true, remaining: config.maxRequests, limit: config.maxRequests, resetSeconds };
  }
}

/**
 * Check rate limit for a given key (typically IP address).
 * Returns true if the request is allowed, false if rate-limited.
 */
export async function checkRateLimit(
  kv: KVNamespace | undefined,
  key: string,
  config: RateLimitConfig = DEFAULT_CONFIG,
): Promise<boolean> {
  const result = await checkRateLimitWithInfo(kv, key, config);
  return result.allowed;
}

/**
 * Get client IP from request headers.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    request.headers.get('X-Real-IP') ||
    'unknown'
  );
}

/**
 * Build a rate limit key from IP and optional user ID.
 * Authenticated users get a per-user key; anonymous get per-IP.
 */
export function buildRateLimitKey(clientIp: string, userId?: string | null): string {
  return userId ? `u:${userId}` : `ip:${clientIp}`;
}

/**
 * Check rate limit using IP + user ID composite key.
 * Authenticated users are limited per user; anonymous per IP.
 */
export async function checkUserRateLimit(
  kv: KVNamespace | undefined,
  clientIp: string,
  userId: string | null | undefined,
  config: RateLimitConfig = DEFAULT_CONFIG,
): Promise<RateLimitResult> {
  const key = buildRateLimitKey(clientIp, userId);
  const result = await checkRateLimitWithInfo(kv, key, config);
  return { ...result, key };
}

/**
 * Hono middleware for rate limiting.
 * Uses IP for anonymous users, user ID for authenticated users.
 */
export function rateLimitMiddleware(config: RateLimitConfig = DEFAULT_CONFIG) {
  return async (
    c: {
      env: { CACHE?: KVNamespace };
      req: { raw: Request };
      get: (key: string) => unknown;
      header: (key: string, value: string) => void;
      json: (body: unknown, status?: number) => Response;
    },
    next: () => Promise<void>,
  ) => {
    const kv = c.env.CACHE;
    const clientIp = getClientIp(c.req.raw);
    const userId = (c.get('user') as { id?: string } | null)?.id;

    const result = await checkUserRateLimit(kv, clientIp, userId, config);

    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      c.header('Retry-After', String(result.resetSeconds));
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    await next();
  };
}
