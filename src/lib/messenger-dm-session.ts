// Per-conversation Double Ratchet session management for DMs (E2EE v2).
//
// Wires X3DH (key agreement) into the Double Ratchet: the first message carries
// an X3DH bootstrap; afterwards both sides continue with the ratchet alone.
// Private material never leaves the client; the server only stores ciphertext.

import { x25519 } from '@noble/curves/ed25519.js';
import { consumeOwnOpkPriv, getE2EEK, getIdentityV2, type IdentityV2 } from './messenger-identity-v2.ts';
import { checkRatchetResetRequest, clearRatchetResetRequest, fetchPreKeyBundle } from './messenger-prekeys.ts';
import { DoubleRatchet, type RatchetHeader } from './messenger-ratchet.ts';
import { bufToBase64, deriveInitialRatchet, type PreKeyBundle, x3dhInitiate, x3dhRespond } from './messenger-x3dh.ts';

export interface DmX3DHBootstrap {
  ikDhPub: string;
  ekPub: string;
  opkId: string;
}

export interface DmSendEnvelope {
  ciphertext: string;
  header: RatchetHeader;
  x3dh?: DmX3DHBootstrap;
}

interface DmSession {
  ratchet: DoubleRatchet;
  bootstrap?: DmX3DHBootstrap;
}

const sessions = new Map<string, DmSession>();
const sessionKey = (dmId: string, peerId: string) => `${dmId}:${peerId}`;

// Successfully decrypted plaintexts keyed by message position
// (`dmId:senderId:ratchetPub:n`). The UI re-renders history and re-runs
// decrypt on messages it has already shown; serving those from cache avoids
// pointless ratchet attempts (a second attempt at a consumed index can never
// succeed) and keeps console noise down.
const plaintextCache = new Map<string, string>();
const PLAINTEXT_CACHE_MAX = 500;
const plaintextKey = (dmId: string, senderId: string, pub: string, n: number) => `${dmId}:${senderId}:${pub}:${n}`;

const subtle = globalThis.crypto?.subtle;

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function freshRatchetPair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const k = x25519.keygen();
  return { secretKey: k.secretKey, publicKey: x25519.getPublicKey(k.secretKey) };
}

// Wrap/unwrap with the E2EE KEK so the server only ever stores ciphertext.
async function wrapWithKek(plain: Uint8Array): Promise<{ enc: string; iv: string }> {
  const kek = getE2EEK();
  if (!kek) throw new Error('E2EE KEK unavailable');
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 },
    kek,
    plain as BufferSource,
  );
  return { enc: bufToBase64(ct), iv: bufToBase64(iv) };
}

async function unwrapWithKek(encB64: string, ivB64: string): Promise<Uint8Array> {
  const kek = getE2EEK();
  if (!kek) throw new Error('E2EE KEK unavailable');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(ivB64) as BufferSource, tagLength: 128 },
    kek,
    base64ToBuf(encB64) as BufferSource,
  );
  return new Uint8Array(pt);
}

// Persist the serialized ratchet (KEK-wrapped) to the server so the session
// survives a reload or spans multiple devices.
export async function persistDmRatchet(conversationId: string, ratchet: DoubleRatchet): Promise<void> {
  try {
    const json = new TextEncoder().encode(JSON.stringify(ratchet.serialize()));
    const { enc, iv } = await wrapWithKek(json);
    await fetch('/api/messenger/ratchet-session', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ conversation_id: conversationId, session_enc: enc, session_iv: iv }),
    });
  } catch {
    /* persistence is best-effort; the in-memory session still works */
  }
}

// Load a previously persisted ratchet for this conversation, or null.
export async function loadDmRatchet(conversationId: string): Promise<DoubleRatchet | null> {
  try {
    if (!getE2EEK()) return null;
    const res = await fetch(`/api/messenger/ratchet-session?conversation_id=${encodeURIComponent(conversationId)}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { exists?: boolean; session_enc?: string; session_iv?: string };
    if (!data.exists || !data.session_enc || !data.session_iv) return null;
    const json = new TextDecoder().decode(await unwrapWithKek(data.session_enc, data.session_iv));
    return DoubleRatchet.deserialize(JSON.parse(json) as never);
  } catch {
    return null;
  }
}

async function clearDmRatchetOnServer(conversationId: string): Promise<void> {
  try {
    await fetch(`/api/messenger/ratchet-session?conversation_id=${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
  } catch {
    /* ignore */
  }
}

// Pure builder: create the initiator's ratchet from a peer's prekey bundle.
export function buildInitiatorRatchet(
  me: IdentityV2,
  peerBundle: PreKeyBundle,
): { ratchet: DoubleRatchet; bootstrap: DmX3DHBootstrap } {
  const init = x3dhInitiate(bufToBase64(me.identityDhPriv), me.identityDhPub, peerBundle);
  const { rootKey, chainKey } = deriveInitialRatchet(init.sharedKey);
  const pair = freshRatchetPair();
  const ratchet = new DoubleRatchet({
    rootKey,
    associatedData: init.associatedData,
    sendRatchetPriv: pair.secretKey,
    sendRatchetPub: pair.publicKey,
    recvRatchetPub: null,
    initialSendChainKey: chainKey,
  });
  const bootstrap: DmX3DHBootstrap = {
    ikDhPub: me.identityDhPub,
    ekPub: init.ephemeralPub,
    opkId: init.preKeyId || '',
  };
  return { ratchet, bootstrap };
}

// Pure builder: create the responder's ratchet from an X3DH bootstrap message.
export function buildResponderRatchet(
  me: IdentityV2,
  oneTimePreKeyPrivB64: string | null,
  bootstrap: DmX3DHBootstrap,
): DoubleRatchet {
  const resp = x3dhRespond(
    bufToBase64(me.identityDhPriv),
    me.identityDhPub,
    bufToBase64(me.spkPriv),
    oneTimePreKeyPrivB64,
    bootstrap.ikDhPub,
    bootstrap.ekPub,
  );
  const { rootKey, chainKey } = deriveInitialRatchet(resp.sharedKey);
  const pair = freshRatchetPair();
  return new DoubleRatchet({
    rootKey,
    associatedData: resp.associatedData,
    sendRatchetPriv: pair.secretKey,
    sendRatchetPub: pair.publicKey,
    recvRatchetPub: null,
    initialRecvChainKey: chainKey,
  });
}

// Serialize session work per conversation+peer. The UI fires many concurrent
// decrypts when rendering history; without this lock each one that finds no
// in-memory session loads the persisted ratchet into a SEPARATE instance and
// they all advance their own copy of the chains (last persist wins, state
// corrupts). The lock also keeps ratchet operations strictly ordered.
const locks = new Map<string, Promise<unknown>>();
async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const done = run
    .catch(() => {})
    .finally(() => {
      if (locks.get(key) === done) locks.delete(key);
    });
  locks.set(key, done);
  return run;
}

// Encrypt a DM as the sender, bootstrapping X3DH on the first message or
// resuming from a persisted ratchet session (survives reload / other devices).
export function encryptDmMessageV2(dmId: string, peerId: string, plaintext: string): Promise<DmSendEnvelope> {
  return withSessionLock(sessionKey(dmId, peerId), () => encryptDmMessageV2Inner(dmId, peerId, plaintext));
}

async function encryptDmMessageV2Inner(dmId: string, peerId: string, plaintext: string): Promise<DmSendEnvelope> {
  const key = sessionKey(dmId, peerId);
  let session = sessions.get(key);
  if (!session) {
    const loaded = await loadDmRatchet(dmId);
    if (loaded) {
      // If the peer asked us to re-bootstrap (they could not decrypt our
      // messages, e.g. a stale pre-fix ratchet), discard the persisted session
      // so this send establishes a fresh X3DH ratchet — recovery works even
      // without actively polling the conversation.
      if (await checkRatchetResetRequest(dmId)) {
        resetDmRatchet(dmId, peerId);
        await clearRatchetResetRequest(dmId);
      } else {
        session = { ratchet: loaded, bootstrap: undefined };
      }
    }
    if (!session) {
      const me = getIdentityV2();
      if (!me) throw new Error('E2EE identity is locked');
      const bundle = await fetchPreKeyBundle(peerId);
      if (!bundle) throw new Error('Peer has no E2EE identity');
      const pk: PreKeyBundle = {
        identitySignPub: bundle.identitySignPub,
        identityDhPub: bundle.identityDhPub,
        signedPreKeyPub: bundle.signedPreKeyPub,
        signedPreKeySignature: bundle.signedPreKeySignature,
        preKeyPub: bundle.preKeyPub ?? undefined,
        preKeyId: bundle.preKeyId ?? undefined,
      };
      const built = buildInitiatorRatchet(me, pk);
      // Always attach the bootstrap. When the peer's OPK pool is empty
      // (preKeyId empty) this is a 2DH handshake — still enough for both sides
      // to derive matching keys, so re-establishment never gets stuck.
      session = { ratchet: built.ratchet, bootstrap: built.bootstrap };
    }
    sessions.set(key, session);
  }
  const msg = session.ratchet.encrypt(plaintext);
  // Only the first message of a fresh session carries the X3DH bootstrap.
  const envelope: DmSendEnvelope = { ciphertext: msg.ciphertext, header: msg.header, x3dh: session.bootstrap };
  session.bootstrap = undefined;
  await persistDmRatchet(dmId, session.ratchet);
  return envelope;
}

// Decrypt a received DM, bootstrapping the responder ratchet if needed or
// resuming from a persisted ratchet session.
export function decryptDmMessageV2(
  dmId: string,
  senderId: string,
  contentJson: string,
  header: RatchetHeader,
): Promise<string> {
  return withSessionLock(sessionKey(dmId, senderId), () =>
    decryptDmMessageV2Inner(dmId, senderId, contentJson, header),
  );
}

async function decryptDmMessageV2Inner(
  dmId: string,
  senderId: string,
  contentJson: string,
  header: RatchetHeader,
): Promise<string> {
  const parsed = JSON.parse(contentJson) as { ct: string; x3dh?: DmX3DHBootstrap };
  const key = sessionKey(dmId, senderId);
  const cacheKey = header ? plaintextKey(dmId, senderId, header.ratchetPub, header.n) : null;
  if (cacheKey) {
    const cached = plaintextCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  let session = sessions.get(key);

  // If the message carries an X3DH bootstrap, (re)establish the responder
  // ratchet. This is how a broken/mismatched session recovers: when the peer
  // re-sends a bootstrap (after "Reset secure session"), we discard any stale
  // session and rebuild a matching one. We only rebuild when we actually
  // obtained the OPK private; if it is gone (already consumed / a stale
  // bootstrap) we keep the existing session instead of building a ratchet that
  // can never decrypt.
  if (parsed.x3dh) {
    const me = getIdentityV2();
    if (!me) throw new Error('E2EE identity is locked');
    let opkPrivB64: string | null = null;
    if (parsed.x3dh.opkId) {
      const opkPriv = await consumeOwnOpkPriv(parsed.x3dh.opkId);
      opkPrivB64 = opkPriv ? bufToBase64(opkPriv) : null;
    }
    // Build a responder ratchet for 3DH (opkId present and consumed) or for the
    // 2DH fallback when the peer had no one-time prekey (opkId empty). Only skip
    // when a 3DH opkId was present but its private is gone — that bootstrap can
    // never be completed, so keep any existing session instead.
    if (opkPrivB64 || !parsed.x3dh.opkId) {
      const ratchet = buildResponderRatchet(me, opkPrivB64, parsed.x3dh);
      session = { ratchet, bootstrap: undefined };
    }
  }

  if (!session) {
    const loaded = await loadDmRatchet(dmId);
    if (loaded) {
      session = { ratchet: loaded, bootstrap: undefined };
    } else if (parsed.x3dh?.opkId) {
      // Bootstrap present but its one-time prekey is gone (a message sent
      // before the X3DH OPK-handling fix deleted it). Permanently undecryptable.
      throw new Error('OPK_UNRECOVERABLE');
    } else {
      throw new Error('No ratchet session and no X3DH bootstrap');
    }
  }
  sessions.set(key, session);
  let own: string | null = null;
  try {
    own = session.ratchet.decryptOwn({ header, ciphertext: parsed.ct });
  } catch {
    own = null;
  }
  const plaintext = own ?? session.ratchet.decrypt({ header, ciphertext: parsed.ct });
  if (cacheKey) {
    if (plaintextCache.size >= PLAINTEXT_CACHE_MAX) {
      const first = plaintextCache.keys().next();
      if (first.value) plaintextCache.delete(first.value);
    }
    plaintextCache.set(cacheKey, plaintext);
  }
  session.bootstrap = undefined;
  await persistDmRatchet(dmId, session.ratchet);
  return plaintext;
}

export function clearDmSessions(): void {
  for (const key of sessions.keys()) {
    const convId = key.split(':')[0];
    void clearDmRatchetOnServer(convId);
  }
  sessions.clear();
}

// Discard the local + persisted ratchet for a single DM so the next outgoing
// message re-bootstraps X3DH from scratch (recovering a broken session). The
// peer automatically rebuilds its side when it receives the new bootstrap.
export function resetDmRatchet(dmId: string, peerId: string): void {
  sessions.delete(sessionKey(dmId, peerId));
  void clearDmRatchetOnServer(dmId);
}
