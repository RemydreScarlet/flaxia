// Identity key lifecycle and per-conversation key cache for E2EE messaging.
//
// The identity private key is kept in memory only. To re-unlock it within a
// session we persist the PBKDF2-derived key-encryption-key (KEK) in
// sessionStorage (never the raw password, never the private key).

import {
  base64ToBuf,
  bufToBase64,
  decryptTextWithKey,
  deriveConversationKey,
  deriveFileKeyFromChannel,
  deriveFileKeyFromConversation,
  deriveKekFromPassword,
  encryptTextWithKey,
  exportPublicKeySpki,
  generateChannelKey,
  generateEcdhKeyPair,
  randomBytes,
  unwrapKeyFromBox,
  unwrapPrivateKey,
  wrapKeyToRecipient,
} from './messenger-crypto.js';

const KEK_STORAGE_KEY = 'flaxia_messenger_kek';

let privateKey: CryptoKey | null = null;
let myPublicKeySpki: string | null = null;

const userPublicKeyCache = new Map<string, string>();
const conversationKeyCache = new Map<string, Uint8Array>();

function storageAvailable(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && !!sessionStorage;
  } catch {
    return false;
  }
}

export async function deriveKek(password: string, saltB64: string): Promise<CryptoKey> {
  return deriveKekFromPassword(password, base64ToBuf(saltB64));
}

export async function persistKek(kek: CryptoKey): Promise<void> {
  if (!storageAvailable()) return;
  try {
    const raw = await crypto.subtle.exportKey('raw', kek);
    sessionStorage.setItem(KEK_STORAGE_KEY, bufToBase64(raw));
  } catch {
    // Non-extractable key; in-memory identity is enough for this session.
  }
}

export async function loadKekFromSession(): Promise<CryptoKey | null> {
  if (!storageAvailable()) return null;
  const b64 = sessionStorage.getItem(KEK_STORAGE_KEY);
  if (!b64) return null;
  try {
    return crypto.subtle.importKey('raw', base64ToBuf(b64) as BufferSource, { name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    sessionStorage.removeItem(KEK_STORAGE_KEY);
    return null;
  }
}

export function clearSessionIdentity(): void {
  if (storageAvailable()) sessionStorage.removeItem(KEK_STORAGE_KEY);
  privateKey = null;
  myPublicKeySpki = null;
  userPublicKeyCache.clear();
  conversationKeyCache.clear();
}

interface MessengerKeyRow {
  exists?: boolean;
  public_key_spki?: string;
  private_key_enc?: string;
  enc_salt?: string;
  enc_iv?: string;
}

async function fetchMyKeys(): Promise<MessengerKeyRow | null> {
  try {
    const res = await fetch('/api/messenger/keys', { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as MessengerKeyRow;
  } catch {
    return null;
  }
}

async function uploadMyKeys(
  publicKeySpki: string,
  privateKeyEnc: string,
  encSalt: string,
  encIv: string,
): Promise<boolean> {
  try {
    const res = await fetch('/api/messenger/keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ publicKeySpki, privateKeyEnc, encSalt, encIv, encVersion: 1 }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Ensure the current user has identity keys, unlocking with the password.
// Returns true when the identity private key is available afterwards.
export async function ensureIdentityKeys(password: string): Promise<boolean> {
  if (privateKey) return true;

  const row = await fetchMyKeys();
  if (row?.private_key_enc && row.enc_salt && row.enc_iv) {
    try {
      const kek = await deriveKek(password, row.enc_salt);
      privateKey = await unwrapPrivateKey(row.private_key_enc, row.enc_iv, kek);
      myPublicKeySpki = row.public_key_spki || null;
      await persistKek(kek);
      return true;
    } catch {
      return false;
    }
  }

  try {
    const pair = await generateEcdhKeyPair();
    const spki = await exportPublicKeySpki(pair.publicKey);
    const salt = randomBytes(16);
    const kek = await deriveKek(password, bufToBase64(salt));
    const wrapped = await crypto.subtle
      .exportKey('pkcs8', pair.privateKey)
      .then((pkcs8) => encryptBytesWithKek(kek, pkcs8));
    const ok = await uploadMyKeys(spki, wrapped.ciphertext, bufToBase64(salt), wrapped.iv);
    if (!ok) return false;
    privateKey = pair.privateKey;
    myPublicKeySpki = spki;
    await persistKek(kek);
    return true;
  } catch {
    return false;
  }
}

async function encryptBytesWithKek(kek: CryptoKey, data: ArrayBuffer): Promise<{ ciphertext: string; iv: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 }, kek, data);
  return { ciphertext: bufToBase64(ct), iv: bufToBase64(iv) };
}

// Unlock using the persisted session KEK (no password needed).
export async function unlockIdentityFromSession(): Promise<boolean> {
  if (privateKey) return true;
  if (!storageAvailable()) return false;
  const kek = await loadKekFromSession();
  if (!kek) return false;
  const row = await fetchMyKeys();
  if (!row?.private_key_enc || !row.enc_iv) return false;
  try {
    privateKey = await unwrapPrivateKey(row.private_key_enc, row.enc_iv, kek);
    myPublicKeySpki = row.public_key_spki || null;
    return true;
  } catch {
    return false;
  }
}

export function isIdentityUnlocked(): boolean {
  return !!privateKey;
}

export function getMyPublicKeySpki(): string | null {
  return myPublicKeySpki;
}

export function getIdentityPrivateKey(): CryptoKey | null {
  return privateKey;
}

// Prefetch users' public keys into the cache.
export async function fetchUserPublicKeys(userIds: string[]): Promise<Map<string, string>> {
  const missing = [...new Set(userIds.filter((id) => !userPublicKeyCache.has(id)))];
  if (missing.length > 0) {
    try {
      const res = await fetch('/api/messenger/keys/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userIds: missing }),
      });
      if (res.ok) {
        const data = (await res.json()) as { keys: Array<{ userId: string; public_key_spki: string }> };
        for (const k of data.keys || []) {
          if (k.public_key_spki) userPublicKeyCache.set(k.userId, k.public_key_spki);
        }
      }
    } catch {
      /* ignore */
    }
  }
  const out = new Map<string, string>();
  for (const id of userIds) {
    const spki = userPublicKeyCache.get(id);
    if (spki) out.set(id, spki);
  }
  return out;
}

// Wrap a channel/group key to members. Members without identity keys are skipped.
export async function wrapKeyForMembers(
  keyBytes: Uint8Array,
  memberPublicKeys: Map<string, string>,
): Promise<Array<{ userId: string; wrappedKey: string; wrappedIv: string }>> {
  const boxes: Array<{ userId: string; wrappedKey: string; wrappedIv: string }> = [];
  for (const [userId, spki] of memberPublicKeys.entries()) {
    try {
      const box = await wrapKeyToRecipient(keyBytes, spki);
      boxes.push({ userId, wrappedKey: box.wrappedKey, wrappedIv: box.wrappedIv });
    } catch {
      /* skip members whose keys we cannot wrap to */
    }
  }
  return boxes;
}

// ─── conversation / channel key management ───────────────────────────────────

function convCacheKey(kind: 'dm' | 'group' | 'server', id: string, keyVersion: number): string {
  return `${kind}:${id}:${keyVersion}`;
}

export function getCachedChannelKey(
  kind: 'dm' | 'group' | 'server',
  id: string,
  keyVersion: number,
): Uint8Array | null {
  return conversationKeyCache.get(convCacheKey(kind, id, keyVersion)) || null;
}

function setCachedChannelKey(kind: 'dm' | 'group' | 'server', id: string, keyVersion: number, key: Uint8Array): void {
  conversationKeyCache.set(convCacheKey(kind, id, keyVersion), key);
  if (conversationKeyCache.size > 200) {
    const firstKey = conversationKeyCache.keys().next().value;
    if (firstKey) conversationKeyCache.delete(firstKey);
  }
}

async function deriveSharedSecretFromSpki(privateKey: CryptoKey, peerPublicKeySpki: string): Promise<ArrayBuffer> {
  const peerPublicKey = await crypto.subtle.importKey(
    'spki',
    base64ToBuf(peerPublicKeySpki) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  return (await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256)) as ArrayBuffer;
}

// DM: derive and cache the conversation key (both parties derive the same).
export async function ensureDmKey(
  conversationId: string,
  keyVersion: number,
  peerUserId: string,
): Promise<Uint8Array | null> {
  const cached = getCachedChannelKey('dm', conversationId, keyVersion);
  if (cached) return cached;
  const priv = privateKey;
  if (!priv) return null;
  const peers = await fetchUserPublicKeys([peerUserId]);
  const peerSpki = peers.get(peerUserId);
  if (!peerSpki) return null;
  try {
    const ss = await deriveSharedSecretFromSpki(priv, peerSpki);
    const key = await deriveConversationKey(ss, conversationId, keyVersion);
    setCachedChannelKey('dm', conversationId, keyVersion, key);
    return key;
  } catch {
    return null;
  }
}

// Group: unwrap all my wrapped group keys into the cache.
export async function ensureGroupKeys(groupId: string, keyVersion: number): Promise<Uint8Array | null> {
  const cached = getCachedChannelKey('group', groupId, keyVersion);
  if (cached) return cached;
  const priv = privateKey;
  if (!priv) return null;
  try {
    const res = await fetch(`/api/groups/${groupId}/keys`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      key_version: number;
      keys: Array<{ key_version: number; wrapped_key: string; wrapped_iv: string }>;
    };
    for (const box of data.keys || []) {
      try {
        const key = await unwrapKeyFromBox({ wrappedKey: box.wrapped_key, wrappedIv: box.wrapped_iv }, priv);
        setCachedChannelKey('group', groupId, box.key_version, key);
      } catch {
        /* bad box */
      }
    }
    return getCachedChannelKey('group', groupId, keyVersion);
  } catch {
    return null;
  }
}

// Server channel: unwrap all my wrapped channel keys into the cache.
export async function ensureChannelKeys(
  serverId: string,
  channelId: string,
  keyVersion: number,
): Promise<Uint8Array | null> {
  const cached = getCachedChannelKey('server', channelId, keyVersion);
  if (cached) return cached;
  const priv = privateKey;
  if (!priv) return null;
  try {
    const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/keys`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      key_version: number;
      keys: Array<{ key_version: number; wrapped_key: string; wrapped_iv: string }>;
    };
    for (const box of data.keys || []) {
      try {
        const key = await unwrapKeyFromBox({ wrappedKey: box.wrapped_key, wrappedIv: box.wrapped_iv }, priv);
        setCachedChannelKey('server', channelId, box.key_version, key);
      } catch {
        /* bad box */
      }
    }
    return getCachedChannelKey('server', channelId, keyVersion);
  } catch {
    return null;
  }
}

// Reconcile channel keys for a server channel: wrap the channel key we hold for
// every supplied member and upload the (idempotent) boxes. Only a member who
// already has the channel key in memory can reconcile, so the server never sees
// plaintext keys. Used to deliver the key to members who joined after the
// channel was created (e.g. via an invite link).
export async function reconcileServerChannelKeys(
  serverId: string,
  channelId: string,
  keyVersion: number,
  memberIds: string[],
): Promise<boolean> {
  const key = getCachedChannelKey('server', channelId, keyVersion);
  if (!key || memberIds.length === 0) return false;
  try {
    const pubKeys = await fetchUserPublicKeys(memberIds);
    if (pubKeys.size === 0) return false;
    const boxes = await wrapKeyForMembers(key, pubKeys);
    if (boxes.length === 0) return false;
    const res = await fetch(`/api/servers/${serverId}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ channelId, keyVersion, boxes }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── text encrypt / decrypt helpers ──────────────────────────────────────────

export async function encryptDmText(
  conversationId: string,
  keyVersion: number,
  peerUserId: string,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string } | null> {
  const key = await ensureDmKey(conversationId, keyVersion, peerUserId);
  if (!key) return null;
  return encryptTextWithKey(key, plaintext);
}

export async function decryptDmText(
  conversationId: string,
  keyVersion: number,
  peerUserId: string,
  ciphertext: string,
  iv: string,
): Promise<string | null> {
  const key = await ensureDmKey(conversationId, keyVersion, peerUserId);
  if (!key) return null;
  try {
    return await decryptTextWithKey(key, ciphertext, iv);
  } catch {
    return null;
  }
}

export async function encryptGroupText(
  groupId: string,
  keyVersion: number,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string } | null> {
  const key = await ensureGroupKeys(groupId, keyVersion);
  if (!key) return null;
  return encryptTextWithKey(key, plaintext);
}

export async function decryptGroupText(
  groupId: string,
  keyVersion: number,
  ciphertext: string,
  iv: string,
): Promise<string | null> {
  const key = await ensureGroupKeys(groupId, keyVersion);
  if (!key) return null;
  try {
    return await decryptTextWithKey(key, ciphertext, iv);
  } catch {
    return null;
  }
}

export async function encryptServerText(
  serverId: string,
  channelId: string,
  keyVersion: number,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string } | null> {
  const key = await ensureChannelKeys(serverId, channelId, keyVersion);
  if (!key) return null;
  return encryptTextWithKey(key, plaintext);
}

export async function decryptServerText(
  serverId: string,
  channelId: string,
  keyVersion: number,
  ciphertext: string,
  iv: string,
): Promise<string | null> {
  const key = await ensureChannelKeys(serverId, channelId, keyVersion);
  if (!key) return null;
  try {
    return await decryptTextWithKey(key, ciphertext, iv);
  } catch {
    return null;
  }
}

// ─── file encrypt / decrypt helpers ──────────────────────────────────────────

// Blob layout: [12-byte IV][GCM ciphertext].
async function encryptFileBytes(fileKey: Uint8Array, data: ArrayBuffer): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    fileKey as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 }, cryptoKey, data);
  const blob = new Uint8Array(12 + ct.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ct), 12);
  return blob;
}

async function decryptFileBlob(fileKey: Uint8Array, data: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  if (bytes.length < 13) throw new Error('Bad file blob');
  const iv = bytes.subarray(0, 12);
  const ct = bytes.subarray(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    fileKey as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  return (await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 },
    cryptoKey,
    ct,
  )) as ArrayBuffer;
}

async function dmSharedSecret(conversationId: string, peerUserId: string): Promise<ArrayBuffer | null> {
  const priv = privateKey;
  if (!priv) return null;
  const peers = await fetchUserPublicKeys([peerUserId]);
  const peerSpki = peers.get(peerUserId);
  if (!peerSpki) return null;
  return deriveSharedSecretFromSpki(priv, peerSpki);
}

export async function encryptFileForDm(
  conversationId: string,
  keyVersion: number,
  peerUserId: string,
  fileContext: string,
  data: ArrayBuffer,
): Promise<Uint8Array | null> {
  const ss = await dmSharedSecret(conversationId, peerUserId);
  if (!ss) return null;
  const fileKey = await deriveFileKeyFromConversation(ss, conversationId, fileContext, keyVersion);
  return encryptFileBytes(fileKey, data);
}

export async function decryptFileForDm(
  conversationId: string,
  keyVersion: number,
  peerUserId: string,
  fileContext: string,
  data: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  const ss = await dmSharedSecret(conversationId, peerUserId);
  if (!ss) return null;
  const fileKey = await deriveFileKeyFromConversation(ss, conversationId, fileContext, keyVersion);
  try {
    return await decryptFileBlob(fileKey, data);
  } catch {
    return null;
  }
}

export async function encryptFileForGroup(
  groupId: string,
  keyVersion: number,
  fileContext: string,
  data: ArrayBuffer,
): Promise<Uint8Array | null> {
  const key = await ensureGroupKeys(groupId, keyVersion);
  if (!key) return null;
  const fileKey = await deriveFileKeyFromChannel(key, fileContext);
  return encryptFileBytes(fileKey, data);
}

export async function decryptFileForGroup(
  groupId: string,
  keyVersion: number,
  fileContext: string,
  data: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  const key = await ensureGroupKeys(groupId, keyVersion);
  if (!key) return null;
  const fileKey = await deriveFileKeyFromChannel(key, fileContext);
  try {
    return await decryptFileBlob(fileKey, data);
  } catch {
    return null;
  }
}

export async function encryptFileForServer(
  serverId: string,
  channelId: string,
  keyVersion: number,
  fileContext: string,
  data: ArrayBuffer,
): Promise<Uint8Array | null> {
  const key = await ensureChannelKeys(serverId, channelId, keyVersion);
  if (!key) return null;
  const fileKey = await deriveFileKeyFromChannel(key, fileContext);
  return encryptFileBytes(fileKey, data);
}

export async function decryptFileForServer(
  serverId: string,
  channelId: string,
  keyVersion: number,
  fileContext: string,
  data: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  const key = await ensureChannelKeys(serverId, channelId, keyVersion);
  if (!key) return null;
  const fileKey = await deriveFileKeyFromChannel(key, fileContext);
  try {
    return await decryptFileBlob(fileKey, data);
  } catch {
    return null;
  }
}

export async function createNewChannelKey(): Promise<Uint8Array> {
  return generateChannelKey();
}
