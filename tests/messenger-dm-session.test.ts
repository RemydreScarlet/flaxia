import assert from 'node:assert';
import { describe, it } from 'node:test';
import { buildInitiatorRatchet, buildResponderRatchet, type DmX3DHBootstrap } from '../src/lib/messenger-dm-session.ts';
import type { IdentityV2 } from '../src/lib/messenger-identity-v2.ts';
import {
  bufToBase64,
  generateIdentityKeyPair,
  generateOneTimePreKeys,
  generateSignedPreKey,
  type PreKeyBundle,
} from '../src/lib/messenger-x3dh.ts';

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

function peerBundle(me: IdentityV2): { bundle: PreKeyBundle; spkPriv: string; opkPriv: string } {
  const spk = { pub: me.spkPub, priv: bufToBase64(me.spkPriv) };
  const opk = generateOneTimePreKeys(1)[0];
  return {
    bundle: {
      identitySignPub: me.identitySignPub,
      identityDhPub: me.identityDhPub,
      signedPreKeyPub: spk.pub,
      signedPreKeySignature: me.spkSig,
      preKeyPub: opk.pub,
      preKeyId: opk.id,
    },
    spkPriv: spk.priv,
    opkPriv: opk.priv,
  };
}

describe('E2EE v2 DM session (X3DH + Double Ratchet)', () => {
  it('establishes a session and exchanges messages both ways', () => {
    const A = fullIdentity();
    const B = fullIdentity();
    const b = peerBundle(B);

    const aBuilt = buildInitiatorRatchet(A, b.bundle);
    const env1 = aBuilt.ratchet.encrypt('hello bob');
    const bootstrap: DmX3DHBootstrap = aBuilt.bootstrap;

    const bRatchet = buildResponderRatchet(B, b.opkPriv, bootstrap);
    assert.equal(bRatchet.decrypt({ header: env1.header, ciphertext: env1.ciphertext }), 'hello bob');

    const env2 = bRatchet.encrypt('hi alice');
    assert.equal(aBuilt.ratchet.decrypt({ header: env2.header, ciphertext: env2.ciphertext }), 'hi alice');
  });

  it('survives a longer back-and-forth with multiple messages', () => {
    const A = fullIdentity();
    const B = fullIdentity();
    const b = peerBundle(B);

    const aBuilt = buildInitiatorRatchet(A, b.bundle);
    const aRatchet = aBuilt.ratchet;
    const bRatchet = buildResponderRatchet(B, b.opkPriv, aBuilt.bootstrap);

    const aToB: string[] = [];
    const bToA: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ea = aRatchet.encrypt(`a${i}`);
      aToB.push(ea.ciphertext);
      assert.equal(bRatchet.decrypt({ header: ea.header, ciphertext: ea.ciphertext }), `a${i}`);
      const eb = bRatchet.encrypt(`b${i}`);
      bToA.push(eb.ciphertext);
      assert.equal(aRatchet.decrypt({ header: eb.header, ciphertext: eb.ciphertext }), `b${i}`);
    }
  });

  it('rejects decryption by a non-participant', () => {
    const A = fullIdentity();
    const B = fullIdentity();
    const C = fullIdentity();
    const b = peerBundle(B);

    const aBuilt = buildInitiatorRatchet(A, b.bundle);
    const aRatchet = aBuilt.ratchet;
    const env = aRatchet.encrypt('secret');
    const cRatchet = buildResponderRatchet(C, b.opkPriv, aBuilt.bootstrap);
    assert.throws(() => cRatchet.decrypt({ header: env.header, ciphertext: env.ciphertext }));
  });
});
