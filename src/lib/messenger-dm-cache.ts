// Durable, client-side cache of decrypted DM plaintext (E2EE v2).
//
// The Double Ratchet is forward-only: a message key, once consumed, can NEVER
// be recomputed. The app re-derives plaintext from the server's ciphertext on
// every render, so after a reload / re-open the ratchet has advanced past the
// old messages and peer history becomes undecryptable ("相手のチャット内容が
// 見えない"). Own messages survive because their send-chain keys are persisted;
// peer messages do not.
//
// Fix: cache each successfully decrypted plaintext locally, KEK-encrypted at
// rest, and read it back before attempting the (now impossible) re-derivation.
// The server keeps only session state + ciphertext; the decrypted cache stays
// on the client.

import { getE2EEK } from './messenger-identity-v2.ts';

const subtle = globalThis.crypto?.subtle;

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

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// KEK-wrap a plaintext string so the stored cache is opaque at rest. The KEK is
// the same password-derived key used everywhere else in the E2EE stack.
async function wrapStringWithKek(plain: string): Promise<{ enc: string; iv: string }> {
  const kek = getE2EEK();
  if (!kek) throw new Error('E2EE KEK unavailable');
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 },
    kek,
    new TextEncoder().encode(plain) as BufferSource,
  );
  return { enc: bufToBase64(ct), iv: bufToBase64(iv) };
}

async function unwrapStringWithKek(encB64: string, ivB64: string): Promise<string> {
  const kek = getE2EEK();
  if (!kek) throw new Error('E2EE KEK unavailable');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(ivB64) as BufferSource, tagLength: 128 },
    kek,
    base64ToBuf(encB64) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

// Storage backend abstraction so tests can inject an in-memory implementation
// (IndexedDB is unavailable under node --test).
export interface DmPlaintextStore {
  get(key: string): Promise<string | null>;
  put(key: string, plaintext: string): Promise<void>;
  clearByConversation(dmId: string): Promise<void>;
}

class MemoryDmPlaintextStore implements DmPlaintextStore {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  async put(key: string, plaintext: string): Promise<void> {
    this.map.set(key, plaintext);
  }
  async clearByConversation(dmId: string): Promise<void> {
    const prefix = `${dmId}:`;
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(prefix)) this.map.delete(k);
    }
  }
}

const DB_NAME = 'flaxia-dm-plaintext';
const STORE = 'plaintext';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

class IdbDmPlaintextStore implements DmPlaintextStore {
  async get(key: string): Promise<string | null> {
    try {
      const db = await openDb();
      return await new Promise<string | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => {
          const v = req.result as { enc: string; iv: string } | undefined;
          if (!v) return resolve(null);
          unwrapStringWithKek(v.enc, v.iv).then(resolve, reject);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async put(key: string, plaintext: string): Promise<void> {
    try {
      const wrapped = await wrapStringWithKek(plaintext);
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(wrapped, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* best-effort: the live in-memory cache still works this session */
    }
  }

  async clearByConversation(dmId: string): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const range = IDBKeyRange.bound(`${dmId}:`, `${dmId}:\uffff`);
        const req = tx.objectStore(STORE).openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* ignore */
    }
  }
}

let storeImpl: DmPlaintextStore =
  typeof indexedDB !== 'undefined' ? new IdbDmPlaintextStore() : new MemoryDmPlaintextStore();

export function getDmPlaintext(key: string): Promise<string | null> {
  return storeImpl.get(key);
}

export function putDmPlaintext(key: string, plaintext: string): Promise<void> {
  return storeImpl.put(key, plaintext);
}

export function clearDmPlaintext(dmId: string): Promise<void> {
  return storeImpl.clearByConversation(dmId);
}

// Test hook: inject an in-memory store so the cache can be exercised under
// node --test (no IndexedDB) and cleared between cases.
export function __setDmPlaintextStoreForTests(s: DmPlaintextStore): void {
  storeImpl = s;
}

export { MemoryDmPlaintextStore };
