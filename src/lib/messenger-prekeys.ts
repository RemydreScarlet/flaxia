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
  identitySignPrivIv: string;
  identityDhPub: string;
  identityDhPrivEnc: string;
  identityDhPrivIv: string;
  spkPub: string;
  spkPrivEnc: string;
  spkPrivIv: string;
  spkSig: string;
  opks: Array<{ id: string; pub: string; privEnc: string; privIv: string }>;
  encSalt: string;
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

export async function replenishOpks(
  opks: Array<{ id: string; pub: string; privEnc: string; privIv: string }>,
): Promise<boolean> {
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

// Ask the peer to re-bootstrap X3DH (their ratchet session is lost / mismatched
// and they cannot decrypt our messages). Idempotent: repeated calls just
// refresh the same request row.
export async function requestRatchetReset(conversationId: string): Promise<void> {
  try {
    await fetch('/api/messenger/ratchet-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ conversation_id: conversationId }),
    });
  } catch {
    /* ignore */
  }
}

// Check whether the peer has asked US to re-bootstrap. Returns true only when
// the pending request was made by the peer (not ourselves).
export async function checkRatchetResetRequest(conversationId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/messenger/ratchet-reset?conversation_id=${encodeURIComponent(conversationId)}`, {
      credentials: 'include',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { requested?: boolean };
    return !!data.requested;
  } catch {
    return false;
  }
}

// Clear a pending reset request after we have acted on it.
export async function clearRatchetResetRequest(conversationId: string): Promise<void> {
  try {
    await fetch(`/api/messenger/ratchet-reset?conversation_id=${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
  } catch {
    /* ignore */
  }
}
