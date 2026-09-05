/**
 * HMAC-based media URL signing utilities.
 *
 * Tokens follow the format: `{expiry}:{hmac_hex}`
 * where hmac_hex = HMAC-SHA256(secret, `{key}:{expiry}`)
 */

export type MediaType = 'image' | 'audio' | 'video' | 'swf' | 'zip';

/** TTL in seconds per media type */
const TOKEN_TTL: Record<MediaType, number> = {
  image: 300, // 5 minutes
  audio: 1800, // 30 minutes
  video: 1800, // 30 minutes
  swf: 3600, // 1 hour (sandbox only)
  zip: 3600, // 1 hour (sandbox only)
};

function getSecret(env: { MEDIA_SIGNING_SECRET?: string }): string {
  if (!env.MEDIA_SIGNING_SECRET) {
    throw new Error('MEDIA_SIGNING_SECRET is not configured');
  }
  return env.MEDIA_SIGNING_SECRET;
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bufToHex(sig);
}

async function hmacVerify(secret: string, data: string, signature: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const sigBytes = hexToUint8Array(signature);
  return crypto.subtle.verify('HMAC', key, sigBytes.buffer as ArrayBuffer, enc.encode(data));
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Generate a signed token for a media key.
 * The token is valid for the duration specified by TOKEN_TTL for the given media type.
 */
export async function createMediaToken(
  env: { MEDIA_SIGNING_SECRET?: string },
  key: string,
  mediaType: MediaType,
): Promise<string> {
  const secret = getSecret(env);
  const ttl = TOKEN_TTL[mediaType];
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const data = `${key}:${expiry}`;
  const signature = await hmacSign(secret, data);
  return `${expiry}:${signature}`;
}

/**
 * Verify a signed token for a media key.
 * Returns true if the token is valid and not expired.
 */
export async function verifyMediaToken(
  env: { MEDIA_SIGNING_SECRET?: string },
  key: string,
  token: string,
): Promise<boolean> {
  try {
    const secret = getSecret(env);
    const colonIdx = token.indexOf(':');
    if (colonIdx === -1) return false;

    const expiryStr = token.substring(0, colonIdx);
    const signature = token.substring(colonIdx + 1);
    const expiry = Number.parseInt(expiryStr, 10);

    if (Number.isNaN(expiry)) return false;
    if (Date.now() / 1000 > expiry) return false;

    const data = `${key}:${expiry}`;
    return hmacVerify(secret, data, signature);
  } catch {
    return false;
  }
}

/**
 * Build a signed URL for a media endpoint.
 */
export async function createSignedMediaUrl(
  env: { MEDIA_SIGNING_SECRET?: string; BASE_URL?: string },
  path: string,
  key: string,
  mediaType: MediaType,
): Promise<string> {
  const token = await createMediaToken(env, key, mediaType);
  const base = env.BASE_URL || 'https://flaxia.app';
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}
