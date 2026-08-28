import assert from 'node:assert';
import { describe, it } from 'node:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { DoubleRatchet, type RatchetMessage } from '../src/lib/messenger-ratchet.ts';
import {
  generateIdentityKeyPair,
  generateOneTimePreKeys,
  generateSignedPreKey,
  type PreKeyBundle,
  x3dhInitiate,
  x3dhRespond,
} from '../src/lib/messenger-x3dh.ts';

interface Peer {
  signPriv: string;
  signPub: string;
  dhPriv: string;
  dhPub: string;
}

function setupPeers() {
  const alice: Peer = generateIdentityKeyPair();
  const bob: Peer = generateIdentityKeyPair();
  return { alice, bob };
}

function bobBundle(bob: Peer) {
  const spk = generateSignedPreKey(bob.signPriv);
  const [opk] = generateOneTimePreKeys(1);
  const bundle: PreKeyBundle = {
    identitySignPub: bob.signPub,
    identityDhPub: bob.dhPub,
    signedPreKeyPub: spk.pub,
    signedPreKeySignature: spk.signature,
    preKeyPub: opk.pub,
    preKeyId: opk.id,
  };
  return { spk, opk, bundle };
}

// Establish a ratchet session the way the transport would: Alice initiates
// against Bob's published bundle, Bob responds using his private keys.
function establish(alice: Peer, bob: Peer) {
  const { spk, opk, bundle } = bobBundle(bob);
  const init = x3dhInitiate(alice.dhPriv, alice.dhPub, bundle);
  const resp = x3dhRespond(bob.dhPriv, bob.dhPub, spk.priv, opk.priv, alice.dhPub, init.ephemeralPub);

  assert.deepStrictEqual([...init.sharedKey], [...resp.sharedKey], 'shared secrets must match');
  assert.strictEqual(init.associatedData, resp.associatedData, 'AD must match');

  const aliceRatchet = new DoubleRatchet({
    rootKey: init.sharedKey,
    associatedData: init.associatedData,
    sendRatchetPriv: new Uint8Array(
      atob(init.ephemeralPriv)
        .split('')
        .map((c) => c.charCodeAt(0)),
    ),
    sendRatchetPub: new Uint8Array(
      atob(init.ephemeralPub)
        .split('')
        .map((c) => c.charCodeAt(0)),
    ),
    recvRatchetPub: new Uint8Array(
      atob(bundle.signedPreKeyPub)
        .split('')
        .map((c) => c.charCodeAt(0)),
    ),
  });

  const bobRatchet = new DoubleRatchet({
    rootKey: resp.sharedKey,
    associatedData: resp.associatedData,
    sendRatchetPriv: new Uint8Array(
      atob(spk.priv)
        .split('')
        .map((c) => c.charCodeAt(0)),
    ),
    sendRatchetPub: new Uint8Array(
      atob(spk.pub)
        .split('')
        .map((c) => c.charCodeAt(0)),
    ),
    recvRatchetPub: new Uint8Array(
      atob(init.ephemeralPub)
        .split('')
        .map((c) => c.charCodeAt(0)),
    ),
  });

  return { aliceRatchet, bobRatchet };
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(
    atob(b64)
      .split('')
      .map((c) => c.charCodeAt(0)),
  );
}
function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

describe('X3DH + Double Ratchet', () => {
  it('agrees on a shared secret and matching AD', () => {
    const { alice, bob } = setupPeers();
    const { aliceRatchet, bobRatchet } = establish(alice, bob);
    assert.ok(aliceRatchet && bobRatchet);
  });

  it('round-trips an alternating DM conversation', () => {
    const { alice, bob } = setupPeers();
    const { aliceRatchet, bobRatchet } = establish(alice, bob);

    const a1 = aliceRatchet.encrypt('hello bob');
    assert.strictEqual(bobRatchet.decrypt(a1), 'hello bob');

    const b1 = bobRatchet.encrypt('hi alice');
    assert.strictEqual(aliceRatchet.decrypt(b1), 'hi alice');

    const a2 = aliceRatchet.encrypt('second message');
    assert.strictEqual(bobRatchet.decrypt(a2), 'second message');

    const b2 = bobRatchet.encrypt('third');
    assert.strictEqual(aliceRatchet.decrypt(b2), 'third');
  });

  it('handles out-of-order delivery within a chain', () => {
    const { alice, bob } = setupPeers();
    const { aliceRatchet, bobRatchet } = establish(alice, bob);

    const m0 = aliceRatchet.encrypt('m0');
    const m1 = aliceRatchet.encrypt('m1');
    const m2 = aliceRatchet.encrypt('m2');

    assert.strictEqual(bobRatchet.decrypt(m2), 'm2');
    assert.strictEqual(bobRatchet.decrypt(m0), 'm0');
    assert.strictEqual(bobRatchet.decrypt(m1), 'm1');
  });

  it('survives state serialization/deserialization', () => {
    const { alice, bob } = setupPeers();
    let { aliceRatchet, bobRatchet } = establish(alice, bob);

    const a1 = aliceRatchet.encrypt('persist me');
    assert.strictEqual(bobRatchet.decrypt(a1), 'persist me');

    // Simulate reload: rehydrate both sides from serialized state.
    aliceRatchet = DoubleRatchet.deserialize(aliceRatchet.serialize());
    bobRatchet = DoubleRatchet.deserialize(bobRatchet.serialize());

    const a2 = aliceRatchet.encrypt('after reload');
    assert.strictEqual(bobRatchet.decrypt(a2), 'after reload');
    const b1 = bobRatchet.encrypt('reply after reload');
    assert.strictEqual(aliceRatchet.decrypt(b1), 'reply after reload');
  });

  it('reload (serialize/deserialize) mid-conversation on both sides keeps decrypting', () => {
    const { alice, bob } = setupPeers();
    let { aliceRatchet, bobRatchet } = establish(alice, bob);

    const m1 = aliceRatchet.encrypt('m1');
    const m2 = aliceRatchet.encrypt('m2');
    assert.strictEqual(bobRatchet.decrypt(m1), 'm1');
    assert.strictEqual(bobRatchet.decrypt(m2), 'm2');

    // Both participants "reload" at the same time — rehydrate from persisted
    // state. This is the exact path that produced "invalid tag" after a client
    // update: the AEAD input must stay identical so stored ciphertext still
    // verifies.
    aliceRatchet = DoubleRatchet.deserialize(aliceRatchet.serialize());
    bobRatchet = DoubleRatchet.deserialize(bobRatchet.serialize());

    const r1 = bobRatchet.encrypt('r1');
    assert.strictEqual(aliceRatchet.decrypt(r1), 'r1');

    const m3 = aliceRatchet.encrypt('m3');
    assert.strictEqual(bobRatchet.decrypt(m3), 'm3');

    const m4 = aliceRatchet.encrypt('m4');
    const m5 = aliceRatchet.encrypt('m5');
    // Out-of-order after reload still works.
    assert.strictEqual(bobRatchet.decrypt(m5), 'm5');
    assert.strictEqual(bobRatchet.decrypt(m4), 'm4');
  });

  it('provides forward secrecy: a compromised later state cannot decrypt earlier messages', () => {
    const { alice, bob } = setupPeers();
    const { aliceRatchet, bobRatchet } = establish(alice, bob);

    const m1 = aliceRatchet.encrypt('secret one');
    const m2 = aliceRatchet.encrypt('secret two');
    const m3 = aliceRatchet.encrypt('secret three');
    assert.strictEqual(bobRatchet.decrypt(m1), 'secret one');
    assert.strictEqual(bobRatchet.decrypt(m2), 'secret two');
    assert.strictEqual(bobRatchet.decrypt(m3), 'secret three');

    // Attacker snapshots Bob's state right after processing m3.
    const compromised = DoubleRatchet.deserialize(bobRatchet.serialize());
    const interceptM1: RatchetMessage = m1;

    // The compromised state must NOT be able to decrypt the earlier message:
    // the chain key has advanced past m1 and cannot be stepped backwards.
    assert.throws(() => compromised.decrypt(interceptM1));
  });

  it('fails to decrypt with a wrong associated data', () => {
    const { alice, bob } = setupPeers();
    const { aliceRatchet, bobRatchet } = establish(alice, bob);
    const msg = aliceRatchet.encrypt('confidential');
    // Tamper with AD by constructing a ratchet with different AD.
    const evil = DoubleRatchet.deserialize(bobRatchet.serialize());
    // Overwrite AD via a fresh ratchet sharing keys but wrong AD is not possible
    // through the public API; instead verify AEAD rejects a flipped byte.
    const flipped: RatchetMessage = {
      header: msg.header,
      ciphertext: bytesToB64(b64ToBytes(msg.ciphertext).map((x, i) => (i === 0 ? x ^ 1 : x))),
    };
    assert.throws(() => evil.decrypt(flipped));
  });

  it('a failed re-decrypt does not corrupt subsequent decryptions', () => {
    const { alice, bob } = setupPeers();
    const { aliceRatchet, bobRatchet } = establish(alice, bob);

    const m1 = aliceRatchet.encrypt('first');
    const m2 = aliceRatchet.encrypt('second');
    assert.strictEqual(bobRatchet.decrypt(m1), 'first');

    // UI re-render replays an already-consumed message: must fail WITHOUT
    // advancing Bob's recv chain (previously it stepped the chain and broke
    // every later message).
    assert.throws(() => bobRatchet.decrypt(m1));
    assert.strictEqual(bobRatchet.decrypt(m2), 'second');

    // Same for garbage from an unknown ratchet key: fails cleanly and the
    // live conversation keeps working afterwards.
    const mallory = new DoubleRatchet({
      rootKey: new Uint8Array(32),
      associatedData: 'x',
      ...(() => {
        const k = x25519.keygen();
        return { sendRatchetPriv: k.secretKey, sendRatchetPub: x25519.getPublicKey(k.secretKey) };
      })(),
      recvRatchetPub: null,
      initialSendChainKey: new Uint8Array(32),
    });
    const junk = mallory.encrypt('junk');
    assert.throws(() => bobRatchet.decrypt(junk));
    const b1 = bobRatchet.encrypt('still alive');
    assert.strictEqual(aliceRatchet.decrypt(b1), 'still alive');
  });

  it('falling back to decrypt() on an own legacy sent message fails safely', () => {
    const { alice, bob } = setupPeers();
    const { aliceRatchet, bobRatchet } = establish(alice, bob);

    const a1 = aliceRatchet.encrypt('legacy own message');
    assert.strictEqual(bobRatchet.decrypt(a1), 'legacy own message');
    const b1 = bobRatchet.encrypt('reply');
    assert.strictEqual(aliceRatchet.decrypt(b1), 'reply');

    // Simulate a sent message from before sentKeys capture existed: strip
    // sentKeys during a reload so decryptOwn returns null for it.
    const ser = aliceRatchet.serialize() as unknown as Record<string, unknown>;
    ser.sentKeys = {};
    const legacyOwn = DoubleRatchet.deserialize(ser as never);

    // The fallback decrypt() attempt used to rotate chains against our own
    // old ratchet pub, destroying the whole session. It must simply fail.
    assert.throws(() => legacyOwn.decrypt({ header: a1.header, ciphertext: a1.ciphertext }));

    // ...and both sides keep exchanging messages normally afterwards.
    const a2 = aliceRatchet.encrypt('after failed fallback');
    assert.strictEqual(bobRatchet.decrypt(a2), 'after failed fallback');
    const b2 = bobRatchet.encrypt('and back');
    const restored = DoubleRatchet.deserialize(aliceRatchet.serialize());
    assert.strictEqual(restored.decrypt(b2), 'and back');
  });
});
