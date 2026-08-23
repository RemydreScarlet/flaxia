import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('E2EE v2 prekey directory', () => {
  beforeEach(resetDb);

  it('publishes identity + OPKs and serves a consumable bundle', async () => {
    const { cookie } = await seedUserAndLogin('pk1');
    const id = (await (await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } })).json()) as {
      user: { id: string };
    };

    const put = await fetch(`${BASE_URL}/api/messenger/identity-v2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        identitySignPub: 'sigPubA',
        identitySignPrivEnc: 'sigPrivEncA',
        identityDhPub: 'dhPubA',
        identityDhPrivEnc: 'dhPrivEncA',
        spkPub: 'spkPubA',
        spkPrivEnc: 'spkPrivEncA',
        spkSig: 'spkSigA',
        opks: [
          { id: 'opk1', pub: 'opkPub1', privEnc: 'opkPrivEnc1' },
          { id: 'opk2', pub: 'opkPub2', privEnc: 'opkPrivEnc2' },
        ],
        encSalt: 'salt',
        encIv: 'iv',
      }),
    });
    assert.equal(put.status, 200);

    const bundle = (await json(
      await fetch(`${BASE_URL}/api/messenger/prekeys?userId=${id.user.id}`, { headers: { Cookie: cookie } }),
    )) as Record<string, unknown>;
    assert.equal(bundle.identitySignPub, 'sigPubA');
    assert.equal(bundle.signedPreKeyPub, 'spkPubA');
    assert.equal(bundle.preKeyPub, 'opkPub1');
    assert.equal(bundle.preKeyId, 'opk1');

    // Consuming the bundle deletes the used one-time prekey.
    const bundle2 = (await json(
      await fetch(`${BASE_URL}/api/messenger/prekeys?userId=${id.user.id}`, { headers: { Cookie: cookie } }),
    )) as Record<string, unknown>;
    assert.equal(bundle2.preKeyPub, 'opkPub2');

    // No more OPKs → bundle still served without a prekey (X3DH without OPK).
    const bundle3 = (await json(
      await fetch(`${BASE_URL}/api/messenger/prekeys?userId=${id.user.id}`, { headers: { Cookie: cookie } }),
    )) as Record<string, unknown>;
    assert.equal(bundle3.preKeyPub, null);
  });

  it('rejects fetching a bundle for a user with no identity', async () => {
    const { cookie } = await seedUserAndLogin('pk2');
    const id = (await (await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } })).json()) as {
      user: { id: string };
    };
    const res = await fetch(`${BASE_URL}/api/messenger/prekeys?userId=${id.user.id}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404);
  });
});
