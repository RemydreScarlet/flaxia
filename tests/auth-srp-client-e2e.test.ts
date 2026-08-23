import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { loginWithSrp, registerWithSrp } from '../src/lib/auth-srp.ts';
import { logoutE2EE, rewrapE2EEIdentityV2, unlockIdentityV2WithPassword } from '../src/lib/messenger-identity-v2.ts';
import { clientStep1, clientStep2, computeVerifier, generateSalt } from '../src/lib/srp.ts';
import { registerUser, resetDb } from './helpers/setup.ts';

function b64(b: Uint8Array): string {
  let binary = '';
  for (const x of b) binary += String.fromCharCode(x);
  return btoa(binary);
}
function unb64(s: string): Uint8Array {
  const binary = atob(s);
  const b = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) b[i] = binary.charCodeAt(i);
  return b;
}

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

  // Replicate the client password-change flow (SettingsPage): prove the current
  // password via an SRP handshake, send a fresh SRP verifier for the new one,
  // then re-wrap the E2EE identity under the new KEK.
  async function changePassword(email: string, currentPassword: string, newPassword: string): Promise<Response> {
    const salt = generateSalt();
    const verifier = await computeVerifier(newPassword, salt);
    const re = await fetch(`${BASE}/api/auth/reauth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    const r = (await re.json()) as { challenge_id: string; salt: string; B: string };
    const { A, a } = await clientStep1(currentPassword, unb64(r.salt));
    const finish = await clientStep2(currentPassword, unb64(r.salt), a, unb64(r.B));
    const res = await fetch(`${BASE}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
        srp_salt: b64(salt),
        srp_verifier: b64(verifier),
        srp_group: '2048',
        current_srp: { challenge_id: r.challenge_id, A: b64(A), M1: b64(finish.M1) },
      }),
    });
    if (res.ok) {
      // Mirror SettingsPage: unlock with the OLD password, then re-wrap under the
      // NEW KEK so the identity stays decryptable.
      await unlockIdentityV2WithPassword(currentPassword);
      await rewrapE2EEIdentityV2(newPassword, salt);
    }
    return res;
  }

  it('changes password (SRP proof) and re-wraps the E2EE identity under the new KEK', async () => {
    assert.ok(await registerWithSrp('pw@example.com', 'pwuser', 'PW User', 'old-password-123'));
    const idBefore = await fetch(`${BASE}/api/messenger/identity-v2`, { credentials: 'include' });
    assert.equal((await idBefore.json()).exists, true);

    const res = await changePassword('pw@example.com', 'old-password-123', 'new-password-456');
    assert.equal(res.status, 200);

    // Old password must no longer unlock; new password must (identity re-wrapped).
    logoutE2EE();
    assert.equal(await unlockIdentityV2WithPassword('old-password-123'), false, 'old password must fail');
    assert.equal(
      await unlockIdentityV2WithPassword('new-password-456'),
      true,
      'new password must unlock re-wrapped identity',
    );

    // Subsequent SRP login with the new password works.
    assert.ok(await loginWithSrp('pw@example.com', 'new-password-456'), 're-login with new password');
  });

  it('rejects an SRP-only password change without a valid current-password proof', async () => {
    assert.ok(await registerWithSrp('sec@example.com', 'secuser', 'Sec User', 'current-pass-1'));
    const salt = generateSalt();
    const verifier = await computeVerifier('new-pass-2', salt);
    // No current_srp proof and no legacy hash -> must be rejected.
    const res = await fetch(`${BASE}/api/users/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        current_password: 'current-pass-1',
        new_password: 'new-pass-2',
        srp_salt: b64(salt),
        srp_verifier: b64(verifier),
        srp_group: '2048',
      }),
    });
    assert.equal(res.status, 401);
  });

  it('unlocks the E2EE identity from the server after a reload (logout) using the password', async () => {
    // Guards against the shared-IV invariant: all wrapped secrets must decrypt
    // with the single stored enc_iv, or E2EE breaks on every reload.
    assert.ok(await registerWithSrp('reload@example.com', 'reloaduser', 'Reload User', 'reload-pass-1'));
    logoutE2EE();
    assert.equal(await unlockIdentityV2WithPassword('reload-pass-1'), true, 'must unlock from server after reload');
  });
});
