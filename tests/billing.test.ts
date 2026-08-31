import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

// ---------------------------------------------------------------------------
// Helper: create a post via the prepare/commit flow
// ---------------------------------------------------------------------------
async function createPost(cookie: string, text = 'test post'): Promise<string> {
  const prep = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'post.txt' }),
  });
  assert.ok(prep.ok, `prepare failed: ${prep.status}`);
  const prepData = (await prep.json()) as { postId?: string };
  assert.ok(prepData.postId, 'prepare should return postId');

  const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ postId: prepData.postId, text }),
  });
  assert.ok(commit.ok, `commit failed: ${commit.status}`);
  return prepData.postId as string;
}

// ===========================================================================
// GET /api/billing/plan
// ===========================================================================
describe('GET /api/billing/plan', () => {
  beforeEach(resetDb);

  it('returns null plan for unauthenticated user', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/plan`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plan: string | null };
    assert.equal(body.plan, null);
  });

  it('returns null plan for user with no subscription', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/plan`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plan: string | null };
    assert.equal(body.plan, null);
  });
});

// ===========================================================================
// POST /api/billing/checkout — validation
// ===========================================================================
describe('POST /api/billing/checkout', () => {
  beforeEach(resetDb);

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: 'flaxia_plus' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects missing planId → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('Invalid plan'));
  });

  it('rejects invalid planId → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ planId: 'nonexistent_plan' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid mode → 400 (or 500 without Stripe key)', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ planId: 'flaxia_plus', mode: 'invalid' }),
    });
    // Without STRIPE_SECRET_KEY, getStripe() throws before the mode check,
    // so we get 500. With a key, we'd get 400.
    assert.ok(res.status === 400 || res.status === 500, `expected 400 or 500, got ${res.status}`);
  });
});

// ===========================================================================
// POST /api/market/checkout — validation
// ===========================================================================
describe('POST /api/market/checkout', () => {
  beforeEach(resetDb);

  it('rejects unauthenticated request → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: 'x', amount: 100 }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects missing postId → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects amount below minimum (100) → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'x', amount: 50 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects amount above maximum (50000) → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'x', amount: 50001 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing amount → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'some-post' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects nonexistent post → 404', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'nonexistent-id', amount: 500 }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('Post not found'));
  });

  it('rejects self-purchase → 400', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createPost(cookie, 'my paid post');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId, amount: 500 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('Cannot purchase your own content'));
  });

  it('allows purchase from another user (validation passes, Stripe call expected to fail)', async () => {
    const seller = await seedUserAndLogin('1');
    const buyer = await seedUserAndLogin('2');
    const postId = await createPost(seller.cookie, 'sellable post');

    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyer.cookie },
      body: JSON.stringify({ postId, amount: 500 }),
    });
    // Without STRIPE_SECRET_KEY the Stripe call will fail, but the validation
    // logic should have passed — the endpoint will return 500 rather than a
    // validation error (400/404).
    assert.notEqual(res.status, 400, 'should not be a validation error');
    assert.notEqual(res.status, 401, 'should not be unauthorized');
    assert.notEqual(res.status, 404, 'should not be not-found');
  });
});

// ===========================================================================
// POST /api/billing/checkout — subscription validation paths
// ===========================================================================
describe('POST /api/billing/checkout — subscription plans', () => {
  beforeEach(resetDb);

  for (const planId of ['flaxia_plus', 'flaxia_plus_plus', 'flaxia_sharp']) {
    it(`accepts valid plan "${planId}" (Stripe call expected to fail without key)`, async () => {
      const { cookie } = await seedUserAndLogin('1');
      const res = await fetch(`${BASE_URL}/api/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ planId, mode: 'subscription' }),
      });
      // Without STRIPE_SECRET_KEY, Stripe will error → 500.  The important
      // thing is that the validation layer accepted the request.
      assert.notEqual(res.status, 400, 'should not be a validation error');
      assert.notEqual(res.status, 401, 'should not be unauthorized');
    });
  }
});

// ===========================================================================
// POST /api/market/checkout — boundary amounts
// ===========================================================================
describe('POST /api/market/checkout — amount boundaries', () => {
  beforeEach(resetDb);

  it('accepts minimum amount (100)', async () => {
    const seller = await seedUserAndLogin('1');
    const buyer = await seedUserAndLogin('2');
    const postId = await createPost(seller.cookie);

    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyer.cookie },
      body: JSON.stringify({ postId, amount: 100 }),
    });
    assert.notEqual(res.status, 400, 'amount 100 should be accepted');
  });

  it('accepts maximum amount (50000)', async () => {
    const seller = await seedUserAndLogin('1');
    const buyer = await seedUserAndLogin('2');
    const postId = await createPost(seller.cookie);

    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyer.cookie },
      body: JSON.stringify({ postId, amount: 50000 }),
    });
    assert.notEqual(res.status, 400, 'amount 50000 should be accepted');
  });

  it('rejects amount 99', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'x', amount: 99 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects amount 50001', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const res = await fetch(`${BASE_URL}/api/market/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId: 'x', amount: 50001 }),
    });
    assert.equal(res.status, 400);
  });
});
