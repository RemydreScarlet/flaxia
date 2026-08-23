// Client-side helpers for the X3DH prekey directory (E2EE v2).
// All private key material passed here is already AES-GCM encrypted with the
// password-derived KEK; the server never receives plaintext private keys.

export interface PreKeyBundleResponse {
  identitySignPub: string;
  identityDhPub: string;
  signedPreKeyPub: string;
  signedPreKeySignature: string;
  signedPreKeyRotatedAt: string;
  preKeyPub: string | null;
  preKeyId: string | null;
}

export interface PublishIdentityParams {
  identitySignPub: string;
  identitySignPrivEnc: string;
  identityDhPub: string;
  identityDhPrivEnc: string;
  spkPub: string;
  spkPrivEnc: string;
  spkSig: string;
  opks: Array<{ id: string; pub: string; privEnc: string }>;
  encSalt: string;
  encIv: string;
}

export async function publishIdentityV2(params: PublishIdentityParams): Promise<boolean> {
  try {
    const res = await fetch('/api/messenger/identity-v2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(params),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function replenishOpks(opks: Array<{ id: string; pub: string; privEnc: string }>): Promise<boolean> {
  try {
    const res = await fetch('/api/messenger/opks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ opks }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchPreKeyBundle(userId: string): Promise<PreKeyBundleResponse | null> {
  try {
    const res = await fetch(`/api/messenger/prekeys?userId=${encodeURIComponent(userId)}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    return (await res.json()) as PreKeyBundleResponse;
  } catch {
    return null;
  }
}
