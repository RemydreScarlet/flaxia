import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { buildInitiatorRatchet, buildResponderRatchet, type DmX3DHBootstrap } from '../src/lib/messenger-dm-session.ts';
import type { IdentityV2 } from '../src/lib/messenger-identity-v2.ts';
import {
  generateIdentityKeyPair,
  generateOneTimePreKeys,
  generateSignedPreKey,
  type PreKeyBundle,
} from '../src/lib/messenger-x3dh.ts';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

function fullIdentity(): IdentityV2 {
  const id = generateIdentityKeyPair();
  const spk = generateSignedPreKey(id.signPriv);
  return {
    identitySignPub: id.signPub,
    identitySignPriv: Uint8Array.from(atob(id.signPriv), (c) => c.charCodeAt(0)),
    identityDhPub: id.dhPub,
    identityDhPriv: Uint8Array.from(atob(id.dhPriv), (c) => c.charCodeAt(0)),
    spkPub: spk.pub,
    spkPriv: Uint8Array.from(atob(spk.priv), (c) => c.charCodeAt(0)),
    spkSig: spk.signature,
  };
}

function peerBundle(me: IdentityV2): { bundle: PreKeyBundle; opkPriv: string } {
  const opk = generateOneTimePreKeys(1)[0];
  return {
    bundle: {
      identitySignPub: me.identitySignPub,
      identityDhPub: me.identityDhPub,
      signedPreKeyPub: me.spkPub,
      signedPreKeySignature: me.spkSig,
      preKeyPub: opk.pub,
      preKeyId: opk.id,
    },
    opkPriv: opk.priv,
  };
}

async function myId(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } });
  return ((await res.json()) as { user: { id: string } }).user.id;
}

async function createConversation(aCookie: string, bId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/dm/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: aCookie },
    body: JSON.stringify({ userId: bId }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function sendDm(
  cookie: string,
  convId: string,
  envelope: { ct: string; header: { ratchetPub: string; pn: number; n: number }; x3dh?: DmX3DHBootstrap },
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/dm/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      content: JSON.stringify({ ct: envelope.ct, x3dh: envelope.x3dh }),
      encVersion: 2,
      ratchetPub: envelope.header.ratchetPub,
      ratchetPn: envelope.header.pn,
      ratchetN: envelope.header.n,
    }),
  });
  assert.equal(res.status, 200);
}

async function getMessages(
  cookie: string,
  convId: string,
): Promise<
  Array<{ content: string; ratchet_pub: string | null; ratchet_pn: number | null; ratchet_n: number | null }>
> {
  const res = await fetch(`${BASE_URL}/api/dm/conversations/${convId}/messages?limit=20`, {
    headers: { Cookie: cookie },
  });
  return ((await res.json()) as { messages: any[] }).messages;
}

describe('E2EE v2 DM end-to-end (X3DH + Double Ratchet via server)', () => {
  beforeEach(resetDb);

  it('exchanges encrypted DMs with forward secrecy and never leaks plaintext', async () => {
    const a = await seedUserAndLogin('e2ea');
    const b = await seedUserAndLogin('e2eb');
    const bId = await myId(b.cookie);
    const convId = await createConversation(a.cookie, bId);

    const A = fullIdentity();
    const B = fullIdentity();
    const bView = peerBundle(B);

    const aBuilt = buildInitiatorRatchet(A, bView.bundle);
    const env1 = aBuilt.ratchet.encrypt('hello bob');

    await sendDm(a.cookie, convId, { ct: env1.ciphertext, header: env1.header, x3dh: aBuilt.bootstrap });

    const bMsgs = await getMessages(b.cookie, convId);
    assert.equal(bMsgs.length, 1);
    const bMsg = bMsgs[0];
    const bParsed = JSON.parse(bMsg.content) as { ct: string; x3dh: DmX3DHBootstrap };
    const bRatchet = buildResponderRatchet(B, bView.opkPriv, bParsed.x3dh);
    assert.equal(
      bRatchet.decrypt({
        header: { ratchetPub: bMsg.ratchet_pub!, pn: bMsg.ratchet_pn!, n: bMsg.ratchet_n! },
        ciphertext: bParsed.ct,
      }),
      'hello bob',
    );
    // last-message preview must not leak plaintext
    const convs = (await (
      await fetch(`${BASE_URL}/api/dm/conversations`, { headers: { Cookie: b.cookie } })
    ).json()) as {
      conversations: Array<{ last_message: { content: string } | null }>;
    };
    assert.equal(convs.conversations[0].last_message?.content, '[Encrypted message]');

    const env2 = bRatchet.encrypt('hi alice');
    await sendDm(b.cookie, convId, { ct: env2.ciphertext, header: env2.header });
    const aMsgs = await getMessages(a.cookie, convId);
    const msg1Content = JSON.stringify({ ct: env1.ciphertext, x3dh: aBuilt.bootstrap });
    const aReply = aMsgs.find((m) => m.content !== msg1Content)!;
    const aParsed = JSON.parse(aReply.content) as { ct: string };
    assert.equal(
      aBuilt.ratchet.decrypt({
        header: { ratchetPub: aReply.ratchet_pub!, pn: aReply.ratchet_pn!, n: aReply.ratchet_n! },
        ciphertext: aParsed.ct,
      }),
      'hi alice',
    );
  });
});
