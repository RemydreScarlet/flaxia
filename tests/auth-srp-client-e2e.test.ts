import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { loginWithSrp, registerWithSrp } from '../src/lib/auth-srp.ts';
import { logoutE2EE } from '../src/lib/messenger-identity-v2.ts';
import { registerUser, resetDb } from './helpers/setup.ts';

// Minimal storage + cookie-jar polyfills so the browser-oriented client code
// (sessionStorage persistence, SameSite session cookies) works under Node.
const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;
(globalThis as unknown as { sessionStorage: Storage; localStorage: Storage }).sessionStorage = storage;
(globalThis as unknown as { sessionStorage: Storage; localStorage: Storage }).localStorage = storage;

const jar = new Map<string, string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  const origin = new URL(url, BASE).origin;
  const headers = new Headers(init?.headers);
  const existing = jar.get(origin);
  if (existing) headers.set('Cookie', existing);
  const absolute = url.startsWith('http') ? url : `${BASE}${url}`;
  const res = await realFetch(absolute, { ...init, headers } as RequestInit);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jar.set(origin, setCookie.split(';')[0]);
  return res;
}) as typeof fetch;

const BASE = 'http://localhost:8788';

describe('Client SRP auth wiring (registerWithSrp / loginWithSrp)', { concurrency: false }, () => {
  beforeEach(async () => {
    jar.clear();
    store.clear();
    logoutE2EE();
    await resetDb();
  });

  it('registers via SRP and provisions an E2EE identity', async () => {
    const ok = await registerWithSrp('client@example.com', 'clientuser', 'Client User', 'wonderful password');
    assert.ok(ok, 'registerWithSrp should succeed');
    const res = await fetch(`${BASE}/api/messenger/identity-v2`);
    const data = (await res.json()) as { exists?: boolean };
    assert.equal(data.exists, true);
  });

  it('logs in via SRP with the correct password and rejects a wrong one', async () => {
    await registerWithSrp('client2@example.com', 'clientuser2', 'Client Two', 'right-password');
    assert.ok(await loginWithSrp('client2@example.com', 'right-password'), 'correct login');
    assert.equal(await loginWithSrp('client2@example.com', 'wrong-password'), false, 'wrong login');
  });

  it('migrates a legacy account to SRP on first SRP-aware login and provisions E2EE', async () => {
    // Register the old (non-SRP) way: plaintext password, no verifier stored.
    const reg = await registerUser({
      email: 'legacy@example.com',
      password: 'legacy-pass-123',
      username: 'legacyuser',
      display_name: 'Legacy User',
    });
    assert.equal(reg.status, 201);

    // loginWithSrp should transparently fall back to legacy login, then upgrade
    // the account to SRP and provision the E2EE identity.
    assert.ok(await loginWithSrp('legacy@example.com', 'legacy-pass-123'), 'migration login');

    // The account now has an SRP verifier.
    const start = await fetch(`${BASE}/api/auth/login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@example.com' }),
    });
    const s = (await start.json()) as { srp: boolean };
    assert.equal(s.srp, true, 'legacy account should now be SRP-upgraded');

    // E2EE identity was provisioned.
    const idRes = await fetch(`${BASE}/api/messenger/identity-v2`);
    const idData = (await idRes.json()) as { exists?: boolean };
    assert.equal(idData.exists, true);

    // Subsequent login uses the SRP path with the same password.
    assert.ok(await loginWithSrp('legacy@example.com', 'legacy-pass-123'), 'SRP re-login');
  });

  it('does not migrate a legacy account when the password is wrong', async () => {
    const reg = await registerUser({
      email: 'legacy2@example.com',
      password: 'correct-pass',
      username: 'legacyuser2',
      display_name: 'Legacy Two',
    });
    assert.equal(reg.status, 201);
    assert.equal(await loginWithSrp('legacy2@example.com', 'wrong-pass'), false, 'wrong legacy password');
    const start = await fetch(`${BASE}/api/auth/login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy2@example.com' }),
    });
    const s = (await start.json()) as { srp: boolean };
    assert.equal(s.srp, false, 'account must NOT be upgraded after a failed login');
  });
});
