// E2EE primitives for the messaging feature.
//
// Design:
// - Identity keys: ECDH P-256 per user. Public key stored SPKI base64;
//   private key (PKCS8) AES-GCM wrapped with a key derived from the user's
//   password via PBKDF2. The server never sees the private key.
// - DMs: 2-party ECDH. Both participants derive the same shared secret and
//   encrypt every message with an AES key derived from it (no key storage).
// - Groups/Servers: per-channel AES-256 key, wrapped per member as a "key box"
//   (ECDH with an ephemeral key + AES-GCM). The ephemeral public key is
//   embedded in the box so any recipient can unwrap it with their own
//   identity private key.
// - Attachments: ciphertext blobs. A file key is derived from the channel key
//   (HKDF) so pre-join members cannot decrypt files uploaded before they join.

const subtle = globalThis.crypto?.subtle;

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const KEY_USAGES: KeyUsage[] = ['deriveBits'] as const;
const PBKDF2_ITERATIONS = 210000;
const HKDF_INFO_PREFIX = 'flaxia/e2ee/v1/';
const AES_GCM_AUTH_BITS = 128;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

function isNode(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

function getRandomBytes(): (length: number) => Uint8Array {
  if (isNode()) {
    const nodeCrypto = globalThis.crypto as Crypto;
    return (length: number) => {
      const out = new Uint8Array(length);
      nodeCrypto.getRandomValues(out);
      return out;
    };
  }
  return (length: number) => {
    const out = new Uint8Array(length);
    globalThis.crypto.getRandomValues(out);
    return out;
  };
}

// ─── base64 (safe for arbitrary bytes and UTF-8) ─────────────────────────────

export function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function strToBase64(str: string): string {
  return bufToBase64(enc.encode(str));
}

export function base64ToStr(b64: string): string {
  return dec.decode(base64ToBuf(b64));
}

export function randomBytes(length: number): Uint8Array {
  return getRandomBytes()(length);
}

// ─── identity key lifecycle ──────────────────────────────────────────────────

export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return (await subtle.generateKey(ECDH_PARAMS, true, KEY_USAGES)) as CryptoKeyPair;
}

export async function exportPublicKeySpki(publicKey: CryptoKey): Promise<string> {
  const spki = await subtle.exportKey('spki', publicKey);
  return bufToBase64(spki);
}

export async function exportPrivateKeyPkcs8(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = await subtle.exportKey('pkcs8', privateKey);
  return bufToBase64(pkcs8);
}

export async function importPublicKeySpki(spkiB64: string): Promise<CryptoKey> {
  return subtle.importKey('spki', base64ToBuf(spkiB64) as BufferSource, ECDH_PARAMS, false, []);
}

export async function importPrivateKeyPkcs8(pkcs8B64: string): Promise<CryptoKey> {
  return subtle.importKey('pkcs8', base64ToBuf(pkcs8B64) as BufferSource, ECDH_PARAMS, false, KEY_USAGES);
}

// PBKDF2 key from the user's password. The raw password is never stored; the
// derived key is retained for the session so we can unwrap identity keys.
export async function deriveKekFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapPrivateKey(
  privateKey: CryptoKey,
  kek: CryptoKey,
): Promise<{ privateKeyEnc: string; encIv: string }> {
  const pkcs8 = await subtle.exportKey('pkcs8', privateKey);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, tagLength: AES_GCM_AUTH_BITS },
    kek,
    pkcs8,
  );
  return { privateKeyEnc: bufToBase64(ct), encIv: bufToBase64(iv) };
}

export async function unwrapPrivateKey(privateKeyEnc: string, encIv: string, kek: CryptoKey): Promise<CryptoKey> {
  const pkcs8 = (await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(encIv) as BufferSource, tagLength: AES_GCM_AUTH_BITS },
    kek,
    base64ToBuf(privateKeyEnc) as BufferSource,
  )) as ArrayBuffer;
  return importPrivateKeyPkcs8(bufToBase64(pkcs8));
}

// ─── shared secrets / message keys ───────────────────────────────────────────

export async function deriveSharedSecret(privateKey: CryptoKey, peerPublicKeySpki: string): Promise<ArrayBuffer> {
  const peerPublicKey = await importPublicKeySpki(peerPublicKeySpki);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256);
  return bits as ArrayBuffer;
}

async function hkdf(
  ikm: BufferSource | Uint8Array,
  salt: BufferSource | Uint8Array,
  info: string,
  length: number,
): Promise<ArrayBuffer> {
  const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  return subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(info) as BufferSource },
    key,
    length * 8,
  ) as Promise<ArrayBuffer>;
}

export async function deriveConversationKey(
  sharedSecret: ArrayBuffer,
  conversationId: string,
  keyVersion: number,
): Promise<Uint8Array> {
  const bytes = await hkdf(
    sharedSecret,
    enc.encode(`conv:${conversationId}`),
    `${HKDF_INFO_PREFIX}conv/v1/kv:${keyVersion}`,
    32,
  );
  return new Uint8Array(bytes);
}

export async function deriveFileKeyFromConversation(
  sharedSecret: ArrayBuffer,
  conversationId: string,
  fileContext: string,
  keyVersion: number,
): Promise<Uint8Array> {
  const bytes = await hkdf(
    sharedSecret,
    enc.encode(`file:${conversationId}`),
    `${HKDF_INFO_PREFIX}conv-file/v1/${fileContext}/kv:${keyVersion}`,
    32,
  );
  return new Uint8Array(bytes);
}

// ─── symmetric helpers (channel / group / server) ────────────────────────────

export async function generateChannelKey(): Promise<Uint8Array> {
  return randomBytes(32);
}

export async function deriveFileKeyFromChannel(channelKey: Uint8Array, fileContext: string): Promise<Uint8Array> {
  const bytes = await hkdf(
    channelKey as BufferSource,
    enc.encode('channel-file'),
    `${HKDF_INFO_PREFIX}channel-file/v1/${fileContext}`,
    32,
  );
  return new Uint8Array(bytes);
}

export async function encryptWithKey(
  key: Uint8Array,
  plaintext: string | BufferSource | Uint8Array,
): Promise<{ ciphertext: string; iv: string }> {
  const cryptoKey = await subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
  ]);
  const iv = randomBytes(12);
  const data: BufferSource =
    typeof plaintext === 'string' ? (enc.encode(plaintext) as BufferSource) : (plaintext as BufferSource);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, tagLength: AES_GCM_AUTH_BITS },
    cryptoKey,
    data,
  );
  return { ciphertext: bufToBase64(ct), iv: bufToBase64(iv) };
}

export async function decryptWithKey(key: Uint8Array, ciphertext: string, iv: string): Promise<ArrayBuffer> {
  const cryptoKey = await subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM', length: 256 }, false, [
    'decrypt',
  ]);
  return subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(iv) as BufferSource, tagLength: AES_GCM_AUTH_BITS },
    cryptoKey,
    base64ToBuf(ciphertext) as BufferSource,
  ) as Promise<ArrayBuffer>;
}

export async function encryptTextWithKey(
  key: Uint8Array,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  return encryptWithKey(key, plaintext);
}

export async function decryptTextWithKey(key: Uint8Array, ciphertext: string, iv: string): Promise<string> {
  const buf = await decryptWithKey(key, ciphertext, iv);
  return dec.decode(buf);
}

// ─── key boxes (wrap a channel/group key to a member) ────────────────────────

export interface KeyBox {
  wrappedKey: string;
  wrappedIv: string;
}

export async function wrapKeyToRecipient(keyBytes: Uint8Array, recipientPublicKeySpki: string): Promise<KeyBox> {
  const ephemeral = await generateEcdhKeyPair();
  const sharedSecret = await deriveSharedSecret(ephemeral.privateKey, recipientPublicKeySpki);
  const kek = new Uint8Array(await hkdf(sharedSecret, enc.encode('box-wrap'), `${HKDF_INFO_PREFIX}box/v1`, 32));
  const { ciphertext, iv } = await encryptWithKey(kek, keyBytes);
  const ephPub = await exportPublicKeySpki(ephemeral.publicKey);
  return { wrappedKey: ciphertext, wrappedIv: `${iv}:${ephPub}` };
}

export async function unwrapKeyFromBox(box: KeyBox, ownPrivateKey: CryptoKey): Promise<Uint8Array> {
  const sep = box.wrappedIv.indexOf(':');
  if (sep <= 0) throw new Error('Malformed key box');
  const iv = box.wrappedIv.slice(0, sep);
  const ephPubB64 = box.wrappedIv.slice(sep + 1);
  const sharedSecret = await deriveSharedSecret(ownPrivateKey, ephPubB64);
  const kek = new Uint8Array(await hkdf(sharedSecret, enc.encode('box-wrap'), `${HKDF_INFO_PREFIX}box/v1`, 32));
  const keyBytes = await decryptWithKey(kek, box.wrappedKey, iv);
  return new Uint8Array(keyBytes);
}
