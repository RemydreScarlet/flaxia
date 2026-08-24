// Double Ratchet (Signal-style) for per-message forward secrecy.
//
// Combines a symmetric-key ratchet (message keys are single use) with a DH
// ratchet (root key advances on every ratchet-key rotation). Compromising a
// single message key reveals only that message; past/future keys are not
// recoverable without the live session state.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const RATCHET_INFO = new TextEncoder().encode('flaxia/ratchet/v1');
const MAX_SKIP = 20000;
const MAX_SKIPPED_KEYS = 4096;

export interface RatchetHeader {
  ratchetPub: string;
  pn: number;
  n: number;
}

export interface RatchetMessage {
  header: RatchetHeader;
  ciphertext: string;
}

interface SerializedRatchet {
  rootKey: string;
  sendChainKey: string | null;
  recvChainKey: string | null;
  sendRatchetPriv: string;
  sendRatchetPub: string;
  recvRatchetPub: string | null;
  sendCount: number;
  recvCount: number;
  prevSendCount: number;
  ratchetPending: boolean;
  associatedData: string;
  skipped: Record<string, string>;
  sentKeys: Record<string, string>;
}

function deriveRoot(root: Uint8Array, dh: Uint8Array): [Uint8Array, Uint8Array] {
  const okm = hkdf(sha512, dh, root, RATCHET_INFO, 64);
  return [new Uint8Array(okm.slice(0, 32)), new Uint8Array(okm.slice(32, 64))];
}

function stepChain(ck: Uint8Array): [Uint8Array, Uint8Array] {
  const mk = hmac(sha256, ck, new Uint8Array([0x01]));
  const next = hmac(sha256, ck, new Uint8Array([0x02]));
  return [new Uint8Array(mk), new Uint8Array(next)];
}

function encodeHeader(h: RatchetHeader): Uint8Array {
  const pub = base64ToBuf(h.ratchetPub);
  const out = new Uint8Array(pub.length + 8);
  out.set(pub, 0);
  const dv = new DataView(out.buffer, out.byteOffset + pub.length, 8);
  dv.setUint32(0, h.pn >>> 0, false);
  dv.setUint32(4, h.n >>> 0, false);
  return out;
}

export class DoubleRatchet {
  private rootKey: Uint8Array;
  private sendChainKey: Uint8Array | null = null;
  private recvChainKey: Uint8Array | null = null;
  private sendRatchetPriv: Uint8Array;
  private sendRatchetPub: Uint8Array;
  private recvRatchetPub: Uint8Array | null = null;
  private sendCount = 0;
  private recvCount = 0;
  private prevSendCount = 0;
  private ratchetPending = false;
  private associatedData: string;
  private skipped = new Map<string, Uint8Array>();
  // Message keys for messages we sent, indexed by `${ratchetPub}:${n}`, so we
  // can decrypt our own outgoing messages (the recv chain can't).
  private sentKeys = new Map<string, Uint8Array>();

  constructor(opts: {
    rootKey: Uint8Array;
    associatedData: string;
    sendRatchetPriv: Uint8Array;
    sendRatchetPub: Uint8Array;
    recvRatchetPub: Uint8Array | null;
    initialSendChainKey?: Uint8Array | null;
    initialRecvChainKey?: Uint8Array | null;
  }) {
    this.rootKey = opts.rootKey;
    this.associatedData = opts.associatedData;
    this.sendRatchetPriv = opts.sendRatchetPriv;
    this.sendRatchetPub = opts.sendRatchetPub;
    this.recvRatchetPub = opts.recvRatchetPub;
    this.sendChainKey = opts.initialSendChainKey ?? null;
    this.recvChainKey = opts.initialRecvChainKey ?? null;
  }

  private aeadKey(mk: Uint8Array, ad: Uint8Array): ReturnType<typeof chacha20poly1305> {
    return chacha20poly1305(mk, new Uint8Array(12), ad);
  }

  encrypt(plaintext: string): RatchetMessage {
    if (!this.sendChainKey) {
      if (!this.recvRatchetPub) throw new Error('Ratchet not initialized for sending');
      const [rk, ck] = deriveRoot(this.rootKey, x25519.getSharedSecret(this.sendRatchetPriv, this.recvRatchetPub));
      this.rootKey = rk;
      this.sendChainKey = ck;
      this.sendCount = 0;
    } else if (this.ratchetPending) {
      const [rk, ck] = this.rotateSendChain();
      this.rootKey = rk;
      this.sendChainKey = ck;
      this.sendCount = 0;
    }

    const [mk, next] = stepChain(this.sendChainKey);
    this.sendChainKey = next;
    const header: RatchetHeader = {
      ratchetPub: bufToBase64(this.sendRatchetPub),
      pn: this.prevSendCount,
      n: this.sendCount,
    };
    this.sentKeys.set(`${header.ratchetPub}:${header.n}`, mk);
    const ad = new Uint8Array([...encodeHeader(header), ...new TextEncoder().encode(this.associatedData)]);
    const ct = this.aeadKey(mk, ad).encrypt(new TextEncoder().encode(plaintext));
    this.sendCount += 1;
    this.ratchetPending = false;
    return { header, ciphertext: bufToBase64(ct) };
  }

  private rotateSendChain(): [Uint8Array, Uint8Array] {
    if (!this.recvRatchetPub) throw new Error('No remote ratchet key to rotate against');
    const next = x25519.keygen();
    const [rk, ck] = deriveRoot(this.rootKey, x25519.getSharedSecret(next.secretKey, this.recvRatchetPub));
    this.sendRatchetPriv = next.secretKey;
    this.sendRatchetPub = x25519.getPublicKey(next.secretKey);
    this.prevSendCount = this.sendCount;
    return [rk, ck];
  }

  decrypt(msg: RatchetMessage): string {
    // Transactional: a failed AEAD verification (wrong key / tampered /
    // already-consumed message being re-decrypted) must leave NO trace on the
    // live session. Without the rollback, a failed attempt permanently
    // advances the chains and corrupts every subsequent decryption.
    const snap = {
      rootKey: this.rootKey,
      sendChainKey: this.sendChainKey,
      recvChainKey: this.recvChainKey,
      sendRatchetPriv: this.sendRatchetPriv,
      sendRatchetPub: this.sendRatchetPub,
      recvRatchetPub: this.recvRatchetPub,
      sendCount: this.sendCount,
      recvCount: this.recvCount,
      prevSendCount: this.prevSendCount,
      ratchetPending: this.ratchetPending,
      skipped: new Map(this.skipped),
    };
    try {
      return this.decryptInner(msg);
    } catch (e) {
      this.rootKey = snap.rootKey;
      this.sendChainKey = snap.sendChainKey;
      this.recvChainKey = snap.recvChainKey;
      this.sendRatchetPriv = snap.sendRatchetPriv;
      this.sendRatchetPub = snap.sendRatchetPub;
      this.recvRatchetPub = snap.recvRatchetPub;
      this.sendCount = snap.sendCount;
      this.recvCount = snap.recvCount;
      this.prevSendCount = snap.prevSendCount;
      this.ratchetPending = snap.ratchetPending;
      this.skipped = snap.skipped;
      throw e;
    }
  }

  private decryptInner(msg: RatchetMessage): string {
    const { header, ciphertext } = msg;
    const key = `${header.ratchetPub}:${header.n}`;
    const cached = this.skipped.get(key);
    if (cached) {
      this.skipped.delete(key);
      return this.finishDecrypt(cached, header, ciphertext);
    }

    const curRecvPub = this.recvRatchetPub ? bufToBase64(this.recvRatchetPub) : null;
    if (header.ratchetPub !== curRecvPub) {
      if (curRecvPub === null) {
        this.recvRatchetPub = base64ToBuf(header.ratchetPub);
      } else {
        if (this.recvChainKey) this.skipTo(header.pn);
        const [rk, ck] = deriveRoot(
          this.rootKey,
          x25519.getSharedSecret(this.sendRatchetPriv, base64ToBuf(header.ratchetPub)),
        );
        this.rootKey = rk;
        this.recvChainKey = ck;
        this.recvRatchetPub = base64ToBuf(header.ratchetPub);
        this.recvCount = 0;
        this.prevSendCount = this.sendCount;
        this.sendCount = 0;
        const next = x25519.keygen();
        this.sendRatchetPriv = next.secretKey;
        this.sendRatchetPub = x25519.getPublicKey(next.secretKey);
      }
    }

    if (!this.recvChainKey) {
      const [rk, ck] = deriveRoot(this.rootKey, x25519.getSharedSecret(this.sendRatchetPriv, this.recvRatchetPub!));
      this.rootKey = rk;
      this.recvChainKey = ck;
      this.recvCount = 0;
    }

    this.skipTo(header.n);
    const [mk, next] = stepChain(this.recvChainKey!);
    this.recvChainKey = next;
    this.recvCount = header.n + 1;
    return this.finishDecrypt(mk, header, ciphertext);
  }

  // Decrypt a message we previously sent, using the captured send-chain message
  // key. Returns null if this ratchet did not send that message (or the key is
  // unavailable), in which case the caller should fall back to decrypt().
  decryptOwn(msg: RatchetMessage): string | null {
    const key = `${msg.header.ratchetPub}:${msg.header.n}`;
    const mk = this.sentKeys.get(key);
    if (!mk) return null;
    try {
      return this.finishDecrypt(mk, msg.header, msg.ciphertext);
    } catch {
      return null;
    }
  }

  private skipTo(N: number): void {
    if (N > this.recvCount + MAX_SKIP) throw new Error('Too many skipped messages');
    while (this.recvCount < N) {
      if (!this.recvChainKey) break;
      const [mk, next] = stepChain(this.recvChainKey);
      this.recvChainKey = next;
      this.skipped.set(`${bufToBase64(this.recvRatchetPub!)}:${this.recvCount}`, mk);
      this.recvCount += 1;
    }
  }

  private finishDecrypt(mk: Uint8Array, header: RatchetHeader, ciphertext: string): string {
    this.ratchetPending = true;
    if (this.skipped.size > MAX_SKIPPED_KEYS) {
      const it = this.skipped.keys().next();
      if (it.value) this.skipped.delete(it.value);
    }
    const ad = new Uint8Array([...encodeHeader(header), ...new TextEncoder().encode(this.associatedData)]);
    const pt = this.aeadKey(mk, ad).decrypt(base64ToBuf(ciphertext));
    return new TextDecoder().decode(pt);
  }

  serialize(): SerializedRatchet {
    const skipped: Record<string, string> = {};
    for (const [k, v] of this.skipped) skipped[k] = bufToBase64(v);
    const sentKeys: Record<string, string> = {};
    for (const [k, v] of this.sentKeys) sentKeys[k] = bufToBase64(v);
    return {
      rootKey: bufToBase64(this.rootKey),
      sendChainKey: this.sendChainKey ? bufToBase64(this.sendChainKey) : null,
      recvChainKey: this.recvChainKey ? bufToBase64(this.recvChainKey) : null,
      sendRatchetPriv: bufToBase64(this.sendRatchetPriv),
      sendRatchetPub: bufToBase64(this.sendRatchetPub),
      recvRatchetPub: this.recvRatchetPub ? bufToBase64(this.recvRatchetPub) : null,
      sendCount: this.sendCount,
      recvCount: this.recvCount,
      prevSendCount: this.prevSendCount,
      ratchetPending: this.ratchetPending,
      associatedData: this.associatedData,
      skipped,
      sentKeys,
    };
  }

  static deserialize(data: SerializedRatchet): DoubleRatchet {
    const r = new DoubleRatchet({
      rootKey: base64ToBuf(data.rootKey),
      associatedData: data.associatedData,
      sendRatchetPriv: base64ToBuf(data.sendRatchetPriv),
      sendRatchetPub: base64ToBuf(data.sendRatchetPub),
      recvRatchetPub: data.recvRatchetPub ? base64ToBuf(data.recvRatchetPub) : null,
    });
    r.sendChainKey = data.sendChainKey ? base64ToBuf(data.sendChainKey) : null;
    r.recvChainKey = data.recvChainKey ? base64ToBuf(data.recvChainKey) : null;
    r.sendCount = data.sendCount;
    r.recvCount = data.recvCount;
    r.prevSendCount = data.prevSendCount;
    r.ratchetPending = data.ratchetPending;
    for (const [k, v] of Object.entries(data.skipped)) r.skipped.set(k, base64ToBuf(v));
    for (const [k, v] of Object.entries(data.sentKeys || {})) r.sentKeys.set(k, base64ToBuf(v));
    return r;
  }
}
