import assert from 'node:assert';
import { describe, it } from 'node:test';
import { BASE_URL, loginUser, registerUser } from './helpers/setup.ts';

// NOTE: self-contained (no resetDb) because the local `--d1=DB_TEST` binding is
// provisioned without migrations, so the shared reset endpoint cannot run here.
// Each test registers a unique user to avoid cross-test state.
async function freshUser(): Promise<{ cookie: string; suffix: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reg = await registerUser({
    email: `evt-${suffix}@test.com`,
    password: 'password123',
    username: `evtuser${suffix}`.slice(0, 20),
    display_name: `Event ${suffix}`,
  });
  assert.equal(reg.status, 201, `register failed: ${await reg.text()}`);
  const { cookie } = await loginUser(`evt-${suffix}@test.com`, 'password123');
  return { cookie, suffix };
}

describe('POST /api/games/events', () => {
  it('rejects unauthenticated requests → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/games/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', events: [] }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects missing sessionId → 400', async () => {
    const { cookie } = await freshUser();
    const res = await fetch(`${BASE_URL}/api/games/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ events: [{ postId: 'p', eventType: 'view', dwellMs: 1 }] }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects empty events → 400', async () => {
    const { cookie } = await freshUser();
    const res = await fetch(`${BASE_URL}/api/games/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sessionId: 's', events: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('records views including sub-2s skips and returns ok', async () => {
    const { cookie } = await freshUser();
    const res = await fetch(`${BASE_URL}/api/games/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        sessionId: 'test-session',
        events: [
          {
            postId: 'p-skip',
            eventType: 'view',
            dwellMs: 800,
            swipeVelocity: 0.9,
            didSkip: 1,
            isFullscreen: 0,
            position: 0,
            gameType: 'zip',
          },
          {
            postId: 'p-watch',
            eventType: 'view',
            dwellMs: 15000,
            swipeVelocity: 0.1,
            didSkip: 0,
            isFullscreen: 0,
            position: 1,
            gameType: 'dos',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);
  });

  it('accepts engagement events (fresh/reply/fullscreen/share)', async () => {
    const { cookie } = await freshUser();
    const res = await fetch(`${BASE_URL}/api/games/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        sessionId: 's2',
        events: [
          { postId: 'p', eventType: 'fresh', dwellMs: 5000, didSkip: 0, isFullscreen: 0, position: 0, gameType: 'zip' },
          { postId: 'p', eventType: 'reply', dwellMs: 6000, didSkip: 0, isFullscreen: 0, position: 0, gameType: 'zip' },
          {
            postId: 'p',
            eventType: 'fullscreen',
            dwellMs: 7000,
            didSkip: 0,
            isFullscreen: 1,
            position: 0,
            gameType: 'zip',
          },
          { postId: 'p', eventType: 'share', dwellMs: 8000, didSkip: 0, isFullscreen: 0, position: 0, gameType: 'zip' },
        ],
      }),
    });
    assert.equal(res.status, 200);
  });

  it('silently drops invalid event types but still succeeds', async () => {
    const { cookie } = await freshUser();
    const res = await fetch(`${BASE_URL}/api/games/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        sessionId: 's3',
        events: [
          { postId: 'p', eventType: 'bogus', dwellMs: 1 },
          { postId: 'p', eventType: 'view', dwellMs: 3000, didSkip: 0, isFullscreen: 0, position: 0, gameType: 'zip' },
        ],
      }),
    });
    assert.equal(res.status, 200);
  });

  it('clamps extreme dwell/position values', async () => {
    const { cookie } = await freshUser();
    const res = await fetch(`${BASE_URL}/api/games/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        sessionId: 's4',
        events: [
          {
            postId: 'p',
            eventType: 'view',
            dwellMs: 999999999,
            swipeVelocity: 9999,
            didSkip: 0,
            isFullscreen: 0,
            position: -5,
            gameType: 'zip',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
  });

  it('mirrors positive-dwell views (>2s) into user_game_plays but not skips', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reg = await registerUser({
      email: `evt-${suffix}@test.com`,
      password: 'password123',
      username: `evtuser${suffix}`.slice(0, 20),
      display_name: `Event ${suffix}`,
    });
    if (reg.status !== 201) {
      assert.fail(`register failed: ${await reg.text()}`);
    }
    const user = ((await reg.json()) as { user: { id: string } }).user;
    const { cookie } = await loginUser(`evt-${suffix}@test.com`, 'password123');

    const res = await fetch(`${BASE_URL}/api/games/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        sessionId: 'mirror-session',
        events: [
          {
            postId: 'p-watch',
            eventType: 'view',
            dwellMs: 15000,
            didSkip: 0,
            isFullscreen: 0,
            position: 0,
            gameType: 'zip',
          },
          {
            postId: 'p-skip',
            eventType: 'view',
            dwellMs: 800,
            didSkip: 1,
            isFullscreen: 0,
            position: 1,
            gameType: 'zip',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);

    const playsRes = await fetch(`${BASE_URL}/api/test/game-plays?userId=${user.id}`);
    assert.equal(playsRes.status, 200);
    const { plays } = (await playsRes.json()) as {
      plays: Array<{ post_id: string; dwell_ms: number; source: string }>;
    };
    assert.deepEqual(plays.map((p) => p.post_id).sort(), ['p-watch']);
    const watch = plays.find((p) => p.post_id === 'p-watch');
    assert.equal(watch?.dwell_ms, 15000);
    assert.equal(watch?.source, 'arcade');
  });
});
