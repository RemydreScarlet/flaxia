import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildRateLimitKey,
  checkRateLimit,
  checkRateLimitWithInfo,
  checkUserRateLimit,
  getClientIp,
} from '../functions/lib/rate-limit.ts';

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: false, cache_status: null }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function createMockRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com', { headers }) as Request;
}

describe('getClientIp', () => {
  it('returns CF-Connecting-IP header', () => {
    const req = createMockRequest({ 'CF-Connecting-IP': '1.2.3.4' });
    assert.strictEqual(getClientIp(req), '1.2.3.4');
  });

  it('returns first X-Forwarded-For IP', () => {
    const req = createMockRequest({ 'X-Forwarded-For': '5.6.7.8, 9.10.11.12' });
    assert.strictEqual(getClientIp(req), '5.6.7.8');
  });

  it('returns X-Real-IP header', () => {
    const req = createMockRequest({ 'X-Real-IP': '13.14.15.16' });
    assert.strictEqual(getClientIp(req), '13.14.15.16');
  });

  it('prefers CF-Connecting-IP over X-Forwarded-For', () => {
    const req = createMockRequest({
      'CF-Connecting-IP': '1.1.1.1',
      'X-Forwarded-For': '2.2.2.2',
    });
    assert.strictEqual(getClientIp(req), '1.1.1.1');
  });

  it('returns unknown when no IP headers', () => {
    const req = createMockRequest();
    assert.strictEqual(getClientIp(req), 'unknown');
  });
});

describe('buildRateLimitKey', () => {
  it('returns IP key for anonymous users', () => {
    assert.strictEqual(buildRateLimitKey('1.2.3.4'), 'ip:1.2.3.4');
  });

  it('returns user key for authenticated users', () => {
    assert.strictEqual(buildRateLimitKey('1.2.3.4', 'user-123'), 'u:user-123');
  });

  it('returns IP key when userId is null', () => {
    assert.strictEqual(buildRateLimitKey('1.2.3.4', null), 'ip:1.2.3.4');
  });

  it('returns IP key when userId is undefined', () => {
    assert.strictEqual(buildRateLimitKey('1.2.3.4', undefined), 'ip:1.2.3.4');
  });
});

describe('checkRateLimitWithInfo', () => {
  it('allows requests within limit', async () => {
    const kv = createMockKV();
    const result = await checkRateLimitWithInfo(kv, 'test-key', {
      maxRequests: 5,
      windowSeconds: 60,
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 4);
    assert.strictEqual(result.limit, 5);
  });

  it('blocks requests exceeding limit', async () => {
    const kv = createMockKV();
    for (let i = 0; i < 5; i++) {
      await checkRateLimitWithInfo(kv, 'test-key', {
        maxRequests: 5,
        windowSeconds: 60,
      });
    }
    const result = await checkRateLimitWithInfo(kv, 'test-key', {
      maxRequests: 5,
      windowSeconds: 60,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.remaining, 0);
  });

  it('allows requests when KV is unavailable', async () => {
    const result = await checkRateLimitWithInfo(undefined, 'test-key', {
      maxRequests: 5,
      windowSeconds: 60,
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 5);
  });

  it('tracks different keys independently', async () => {
    const kv = createMockKV();
    for (let i = 0; i < 3; i++) {
      await checkRateLimitWithInfo(kv, 'key-a', { maxRequests: 3, windowSeconds: 60 });
    }
    const resultA = await checkRateLimitWithInfo(kv, 'key-a', {
      maxRequests: 3,
      windowSeconds: 60,
    });
    const resultB = await checkRateLimitWithInfo(kv, 'key-b', {
      maxRequests: 3,
      windowSeconds: 60,
    });
    assert.strictEqual(resultA.allowed, false);
    assert.strictEqual(resultB.allowed, true);
  });
});

describe('checkRateLimit', () => {
  it('returns true when allowed', async () => {
    const kv = createMockKV();
    const allowed = await checkRateLimit(kv, 'test-key', {
      maxRequests: 5,
      windowSeconds: 60,
    });
    assert.strictEqual(allowed, true);
  });

  it('returns false when exceeded', async () => {
    const kv = createMockKV();
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(kv, 'test-key', { maxRequests: 5, windowSeconds: 60 });
    }
    const allowed = await checkRateLimit(kv, 'test-key', {
      maxRequests: 5,
      windowSeconds: 60,
    });
    assert.strictEqual(allowed, false);
  });
});

describe('checkUserRateLimit', () => {
  it('limits anonymous users by IP', async () => {
    const kv = createMockKV();
    for (let i = 0; i < 3; i++) {
      await checkUserRateLimit(kv, '1.2.3.4', null, { maxRequests: 3, windowSeconds: 60 });
    }
    const result = await checkUserRateLimit(kv, '1.2.3.4', null, {
      maxRequests: 3,
      windowSeconds: 60,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.key, 'ip:1.2.3.4');
  });

  it('limits authenticated users by user ID', async () => {
    const kv = createMockKV();
    for (let i = 0; i < 3; i++) {
      await checkUserRateLimit(kv, '1.2.3.4', 'user-123', {
        maxRequests: 3,
        windowSeconds: 60,
      });
    }
    const result = await checkUserRateLimit(kv, '1.2.3.4', 'user-123', {
      maxRequests: 3,
      windowSeconds: 60,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.key, 'u:user-123');
  });

  it('tracks IP and user ID separately', async () => {
    const kv = createMockKV();
    for (let i = 0; i < 3; i++) {
      await checkUserRateLimit(kv, '1.2.3.4', null, { maxRequests: 3, windowSeconds: 60 });
    }
    const anonResult = await checkUserRateLimit(kv, '1.2.3.4', null, {
      maxRequests: 3,
      windowSeconds: 60,
    });
    const userResult = await checkUserRateLimit(kv, '1.2.3.4', 'user-123', {
      maxRequests: 3,
      windowSeconds: 60,
    });
    assert.strictEqual(anonResult.allowed, false);
    assert.strictEqual(userResult.allowed, true);
  });

  it('allows requests when KV is unavailable', async () => {
    const result = await checkUserRateLimit(undefined, '1.2.3.4', 'user-123', {
      maxRequests: 3,
      windowSeconds: 60,
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 3);
  });
});
