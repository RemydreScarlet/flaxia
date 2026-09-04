import assert from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { generateAndPublishIdentityV2 } from '../src/lib/messenger-identity-v2.ts';

function installedCrypto(): boolean {
  return (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  );
}

describe('messenger identity v2 IV isolation', () => {
  afterEach(() => mock.reset());

  it('uses a distinct AES-GCM IV per encrypted private field', async () => {
    if (!installedCrypto()) {
      // Skip when the runtime lacks Web Crypto (should not happen on Node 20+).
      return;
    }

    let captured: Record<string, unknown> | null = null;
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      if (init && typeof init.body === 'string') {
        captured = JSON.parse(init.body) as Record<string, unknown>;
      }
      return new Response(null, { status: 200 });
    });

    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const ok = await generateAndPublishIdentityV2('test-password', salt);
    assert.equal(ok, true);
    assert.ok(captured, 'identity PUT body should have been captured');

    const signIv = captured!.identitySignPrivIv as string;
    const dhIv = captured!.identityDhPrivIv as string;
    const spkIv = captured!.spkPrivIv as string;
    const opks = captured!.opks as Array<{ id: string; privEnc: string; privIv: string }>;

    // None of the per-field IVs may collide, otherwise we reintroduce the
    // AES-GCM (key, nonce) reuse vulnerability.
    assert.ok(signIv && dhIv && spkIv, 'all identity field IVs must be present');
    assert.notEqual(signIv, dhIv, 'sign and dh IVs must differ');
    assert.notEqual(signIv, spkIv, 'sign and spk IVs must differ');
    assert.notEqual(dhIv, spkIv, 'dh and spk IVs must differ');

    assert.ok(opks.length > 0, 'opks should be published');
    const ivs = new Set([signIv, dhIv, spkIv, ...opks.map((o) => o.privIv)]);
    assert.equal(ivs.size, 3 + opks.length, 'every encrypted blob needs a unique IV');
  });
});
