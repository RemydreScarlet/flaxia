import { Hono } from 'hono';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const msig = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Messenger E2EE identity keys ─────────────────────────────────────────────

// GET /api/messenger/keys - get my identity public key + encrypted private key
msig.get('/messenger/keys', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const row = (await c.env.DB.prepare(
      'SELECT public_key_spki, private_key_enc, enc_salt, enc_iv, enc_version FROM messenger_keys WHERE user_id = ?',
    )
      .bind(userId)
      .first()) as Record<string, unknown> | null;

    if (!row) return c.json({ exists: false });
    return c.json({
      exists: true,
      public_key_spki: row.public_key_spki,
      private_key_enc: row.private_key_enc,
      enc_salt: row.enc_salt,
      enc_iv: row.enc_iv,
      enc_version: row.enc_version || 1,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Messenger keys get error:', error);
    return c.json({ error: 'Failed to fetch keys', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/messenger/keys - register my identity keys (server never sees the private key)
msig.put('/messenger/keys', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const { publicKeySpki, privateKeyEnc, encSalt, encIv, encVersion } = (await c.req.json()) as {
      publicKeySpki?: string;
      privateKeyEnc?: string;
      encSalt?: string;
      encIv?: string;
      encVersion?: number;
    };

    if (!publicKeySpki || !privateKeyEnc || !encSalt || !encIv) {
      return c.json({ error: 'publicKeySpki, privateKeyEnc, encSalt and encIv are required' }, 400);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO messenger_keys (user_id, public_key_spki, private_key_enc, enc_salt, enc_iv, enc_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         public_key_spki = excluded.public_key_spki,
         private_key_enc = excluded.private_key_enc,
         enc_salt = excluded.enc_salt,
         enc_iv = excluded.enc_iv,
         enc_version = excluded.enc_version,
         updated_at = excluded.updated_at`,
    )
      .bind(userId, publicKeySpki, privateKeyEnc, encSalt, encIv, encVersion || 1, now, now)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Messenger keys put error:', error);
    return c.json({ error: 'Failed to save keys', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/messenger/keys/bulk - fetch public keys for many users (for key wrapping)
msig.post('/messenger/keys/bulk', requireAuth, async (c) => {
  try {
    const { userIds } = (await c.req.json()) as { userIds?: string[] };
    if (!userIds || userIds.length === 0) {
      return c.json({ error: 'userIds is required' }, 400);
    }
    const unique = [...new Set(userIds)];
    const keys = await c.env.DB.prepare(
      `SELECT user_id, public_key_spki FROM messenger_keys WHERE user_id IN (${unique.map(() => '?').join(',')})`,
    )
      .bind(...unique)
      .all();

    const map = new Map<string, unknown>();
    for (const row of keys.results || []) {
      const r = row as Record<string, unknown>;
      map.set(r.user_id as string, r.public_key_spki);
    }

    return c.json({
      keys: unique.filter((id) => map.has(id)).map((id) => ({ userId: id, public_key_spki: map.get(id) })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Messenger keys bulk error:', error);
    return c.json({ error: 'Failed to fetch keys', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Messenger E2EE v2: X3DH prekey bundles (forward secrecy) ──────────────────

// GET /api/messenger/identity-v2 - fetch my own v2 identity (private material is
// AES-GCM encrypted; the client unwraps it with the password-derived KEK).
msig.get('/messenger/identity-v2', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const row = (await c.env.DB.prepare(
      `SELECT identity_sign_pub, identity_sign_priv_enc, identity_sign_priv_iv,
              identity_dh_pub, identity_dh_priv_enc, identity_dh_priv_iv,
              spk_pub, spk_priv_enc, spk_priv_iv, spk_sig, enc_salt, enc_version
       FROM messenger_identity_v2 WHERE user_id = ?`,
    )
      .bind(userId)
      .first()) as Record<string, unknown> | null;
    if (!row) return c.json({ exists: false });
    return c.json({
      exists: true,
      identitySignPub: row.identity_sign_pub,
      identitySignPrivEnc: row.identity_sign_priv_enc,
      identitySignPrivIv: row.identity_sign_priv_iv,
      identityDhPub: row.identity_dh_pub,
      identityDhPrivEnc: row.identity_dh_priv_enc,
      identityDhPrivIv: row.identity_dh_priv_iv,
      spkPub: row.spk_pub,
      spkPrivEnc: row.spk_priv_enc,
      spkPrivIv: row.spk_priv_iv,
      spkSig: row.spk_sig,
      encSalt: row.enc_salt,
      encVersion: row.enc_version || 2,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Messenger identity-v2 get error:', error);
    return c.json({ error: 'Failed to fetch identity', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/messenger/prekeys?userId=... - fetch a public prekey bundle for X3DH.
// Consumes (deletes) one one-time prekey so it cannot be reused.
msig.get('/messenger/prekeys', requireAuth, async (c) => {
  try {
    const userId = c.req.query('userId');
    if (!userId) return c.json({ error: 'userId is required' }, 400);

    const ident = (await c.env.DB.prepare(
      `SELECT identity_sign_pub, identity_dh_pub, spk_pub, spk_sig, spk_rotated_at
       FROM messenger_identity_v2 WHERE user_id = ?`,
    )
      .bind(userId)
      .first()) as Record<string, unknown> | null;
    if (!ident) return c.json({ error: 'No identity registered' }, 404);

    // Reclaim one-time prekeys that were reserved (claimed) by an abandoned
    // session start, so the pool cannot get permanently stuck. A reservation
    // older than 5 minutes is treated as freed and becomes available again.
    await c.env.DB.prepare(
      `UPDATE messenger_opks SET claimed_at = NULL WHERE user_id = ? AND claimed_at IS NOT NULL AND claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')`,
    )
      .bind(userId)
      .run();

    const opk = (await c.env.DB.prepare(
      `SELECT id, pub FROM messenger_opks WHERE user_id = ? AND claimed_at IS NULL ORDER BY created_at LIMIT 1`,
    )
      .bind(userId)
      .first()) as Record<string, unknown> | null;

    if (opk) {
      // Reserve this OPK so it is not handed to another initiator, but do NOT
      // delete it: the responder still needs its private material via
      // POST /api/messenger/opks/consume to complete X3DH (the DH4 step).
      await c.env.DB.prepare(
        `UPDATE messenger_opks SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
        .bind(opk.id as string)
        .run();
    }

    const remaining = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messenger_opks WHERE user_id = ? AND claimed_at IS NULL`,
    )
      .bind(userId)
      .first()) as { n?: number } | null;

    return c.json({
      identitySignPub: ident.identity_sign_pub,
      identityDhPub: ident.identity_dh_pub,
      signedPreKeyPub: ident.spk_pub,
      signedPreKeySignature: ident.spk_sig,
      signedPreKeyRotatedAt: ident.spk_rotated_at,
      preKeyPub: opk?.pub ?? null,
      preKeyId: opk?.id ?? null,
      opkCount: remaining?.n ?? 0,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Messenger prekeys get error:', error);
    return c.json({ error: 'Failed to fetch prekeys', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/messenger/opks/consume - fetch one of MY one-time prekeys' private
// material and delete it, so it can never be reused. Called by the responder
// during X3DH to recover the OPK private that the initiator consumed.
msig.post('/messenger/opks/consume', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const body = (await c.req.json()) as { opkId?: string };
    if (!body.opkId) return c.json({ error: 'opkId is required' }, 400);

    const opk = (await c.env.DB.prepare(`SELECT priv_enc, priv_iv FROM messenger_opks WHERE id = ? AND user_id = ?`)
      .bind(body.opkId, userId)
      .first()) as Record<string, unknown> | null;
    if (!opk) {
      // 診断: user_id フィルタを外して存在するか確認し、404 の理由を特定する
      const diag = (await c.env.DB.prepare(`SELECT id, user_id, claimed_at FROM messenger_opks WHERE id = ?`)
        .bind(body.opkId)
        .first()) as Record<string, unknown> | null;
      if (!diag) {
        console.warn(`[opks/consume] OPK ${body.opkId} はどのユーザーにも存在しません (requester=${userId})`);
      } else {
        console.warn(
          `[opks/consume] OPK ${body.opkId} は別ユーザー ${diag.user_id} のもの (requester=${userId}, claimed_at=${diag.claimed_at})`,
        );
      }
      return c.json({ error: 'OPK not found' }, 404);
    }

    // Mark the OPK consumed but DO NOT delete it. X3DH consumes the one-time
    // prekey to complete the handshake; if the responder's ratchet is later
    // lost (e.g. cleared locally) it must re-consume the SAME opkId to rebuild
    // the identical ratchet and keep decrypting history, instead of hitting 404
    // and permanently losing the conversation. A sentinel claimed_at keeps it
    // reserved (never re-handed out / never reclaimed) without weakening the
    // single-use property of the established session.
    await c.env.DB.prepare(`UPDATE messenger_opks SET claimed_at = '9999-01-01T00:00:00Z' WHERE id = ? AND user_id = ?`)
      .bind(body.opkId, userId)
      .run();

    return c.json({ privEnc: opk.priv_enc, privIv: opk.priv_iv ?? null });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Messenger opks consume error:', error);
    return c.json({ error: 'Failed to consume OPK', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/messenger/identity-v2 - register identity + signed prekey + OPKs.
// Private material is already AES-GCM encrypted client-side with the password KEK.
msig.put('/messenger/identity-v2', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const body = (await c.req.json()) as {
      identitySignPub?: string;
      identitySignPrivEnc?: string;
      identitySignPrivIv?: string;
      identityDhPub?: string;
      identityDhPrivEnc?: string;
      identityDhPrivIv?: string;
      spkPub?: string;
      spkPrivEnc?: string;
      spkPrivIv?: string;
      spkSig?: string;
      opks?: Array<{ id: string; pub: string; privEnc: string; privIv: string }>;
      encSalt?: string;
    };
    if (
      !body.identitySignPub ||
      !body.identitySignPrivEnc ||
      !body.identitySignPrivIv ||
      !body.identityDhPub ||
      !body.identityDhPrivEnc ||
      !body.identityDhPrivIv ||
      !body.spkPub ||
      !body.spkPrivEnc ||
      !body.spkPrivIv ||
      !body.spkSig ||
      !body.encSalt
    ) {
      return c.json({ error: 'Missing identity fields' }, 400);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO messenger_identity_v2
        (user_id, identity_sign_pub, identity_sign_priv_enc, identity_sign_priv_iv,
         identity_dh_pub, identity_dh_priv_enc, identity_dh_priv_iv,
         spk_pub, spk_priv_enc, spk_priv_iv, spk_sig, enc_salt, enc_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         identity_sign_pub = excluded.identity_sign_pub,
         identity_sign_priv_enc = excluded.identity_sign_priv_enc,
         identity_sign_priv_iv = excluded.identity_sign_priv_iv,
         identity_dh_pub = excluded.identity_dh_pub,
         identity_dh_priv_enc = excluded.identity_dh_priv_enc,
         identity_dh_priv_iv = excluded.identity_dh_priv_iv,
         spk_pub = excluded.spk_pub,
         spk_priv_enc = excluded.spk_priv_enc,
         spk_priv_iv = excluded.spk_priv_iv,
         spk_sig = excluded.spk_sig,
         spk_rotated_at = excluded.updated_at,
         enc_salt = excluded.enc_salt,
         updated_at = excluded.updated_at`,
    )
      .bind(
        userId,
        body.identitySignPub,
        body.identitySignPrivEnc,
        body.identitySignPrivIv,
        body.identityDhPub,
        body.identityDhPrivEnc,
        body.identityDhPrivIv,
        body.spkPub,
        body.spkPrivEnc,
        body.spkPrivIv,
        body.spkSig,
        body.encSalt,
        now,
        now,
      )
      .run();

    if (body.opks && body.opks.length > 0) {
      const insert = c.env.DB.prepare(
        'INSERT OR REPLACE INTO messenger_opks (id, user_id, pub, priv_enc, priv_iv) VALUES (?, ?, ?, ?, ?)',
      );
      const batch = body.opks.map((o) => insert.bind(o.id, userId, o.pub, o.privEnc, o.privIv));
      await c.env.DB.batch(batch);
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Messenger identity-v2 put error:', error);
    return c.json({ error: 'Failed to save identity', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/messenger/ratchet-session - persist a KEK-wrapped Double Ratchet
// session so it survives reloads / multiple devices. The server only stores
// ciphertext; the KEK never leaves the client.
msig.put('/messenger/ratchet-session', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id;
    const { conversation_id, device_id, session_enc, session_iv } = (await c.req.json()) as {
      conversation_id?: string;
      device_id?: string;
      session_enc?: string;
      session_iv?: string;
    };
    if (!userId || !conversation_id || !device_id || !session_enc || !session_iv) {
      return c.json({ error: 'Missing session fields' }, 400);
    }
    const now = new Date().toISOString();
    const result = await c.env.DB.prepare(
      `INSERT INTO messenger_ratchet_sessions (user_id, conversation_id, device_id, session_enc, session_iv, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, conversation_id, device_id) DO UPDATE SET
         session_enc = excluded.session_enc,
         session_iv = excluded.session_iv,
         updated_at = excluded.updated_at`,
    )
      .bind(userId, conversation_id, device_id, session_enc, session_iv, now)
      .run();
    if (!result.success) return c.json({ error: 'Failed to save session' }, 500);
    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Ratchet session put error:', error);
    return c.json({ error: 'Failed to save session' }, 500);
  }
});

// GET /api/messenger/ratchet-session?conversation_id=... - fetch the persisted
// KEK-wrapped ratchet session for the current user + conversation.
msig.get('/messenger/ratchet-session', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id;
    const convId = c.req.query('conversation_id');
    const deviceId = c.req.query('device_id');
    if (!userId || !convId || !deviceId) return c.json({ error: 'conversation_id and device_id required' }, 400);
    const row = (await c.env.DB.prepare(
      'SELECT session_enc, session_iv FROM messenger_ratchet_sessions WHERE user_id = ? AND conversation_id = ? AND device_id = ?',
    )
      .bind(userId, convId, deviceId)
      .first()) as { session_enc: string; session_iv: string } | null;
    if (!row) return c.json({ exists: false });
    return c.json({ exists: true, session_enc: row.session_enc, session_iv: row.session_iv });
  } catch (error: unknown) {
    console.error('Ratchet session get error:', error);
    return c.json({ error: 'Failed to fetch session' }, 500);
  }
});

// DELETE /api/messenger/ratchet-session?conversation_id=... - drop a persisted
// ratchet session (e.g. on logout).
msig.delete('/messenger/ratchet-session', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id;
    const convId = c.req.query('conversation_id');
    const deviceId = c.req.query('device_id');
    if (!userId || !convId || !deviceId) return c.json({ error: 'conversation_id and device_id required' }, 400);
    await c.env.DB.prepare(
      'DELETE FROM messenger_ratchet_sessions WHERE user_id = ? AND conversation_id = ? AND device_id = ?',
    )
      .bind(userId, convId, deviceId)
      .run();
    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Ratchet session delete error:', error);
    return c.json({ error: 'Failed to delete session' }, 500);
  }
});

// POST /api/messenger/ratchet-reset - request the peer to re-bootstrap X3DH.
// Used when this participant cannot decrypt the peer's messages (lost /
// mismatched ratchet). The peer polls for the request and resets its own
// session, so a single "Reset secure session" recovers BOTH sides.
msig.post('/messenger/ratchet-reset', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id;
    const { conversation_id } = (await c.req.json()) as { conversation_id?: string };
    if (!userId || !conversation_id) return c.json({ error: 'conversation_id required' }, 400);
    const now = new Date().toISOString();
    const result = await c.env.DB.prepare(
      `INSERT INTO messenger_ratchet_reset_requests (conversation_id, requested_by, requested_at)
       VALUES (?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET requested_by = excluded.requested_by, requested_at = excluded.requested_at`,
    )
      .bind(conversation_id, userId, now)
      .run();
    if (!result.success) return c.json({ error: 'Failed to request reset' }, 500);
    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Ratchet reset request error:', error);
    return c.json({ error: 'Failed to request reset' }, 500);
  }
});

// GET /api/messenger/ratchet-reset?conversation_id=... - check whether the peer
// has requested that WE re-bootstrap. Returns requested:true only when the
// pending request was made by someone other than the caller.
msig.get('/messenger/ratchet-reset', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id;
    const convId = c.req.query('conversation_id');
    if (!userId || !convId) return c.json({ error: 'conversation_id required' }, 400);
    const row = (await c.env.DB.prepare(
      'SELECT requested_by FROM messenger_ratchet_reset_requests WHERE conversation_id = ?',
    )
      .bind(convId)
      .first()) as { requested_by: string } | null;
    if (!row || row.requested_by === userId) return c.json({ requested: false });
    return c.json({ requested: true });
  } catch (error: unknown) {
    console.error('Ratchet reset check error:', error);
    return c.json({ error: 'Failed to check reset' }, 500);
  }
});

// DELETE /api/messenger/ratchet-reset?conversation_id=... - clear a pending
// reset request (called by the peer after it has reset its own session).
msig.delete('/messenger/ratchet-reset', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id;
    const convId = c.req.query('conversation_id');
    if (!userId || !convId) return c.json({ error: 'conversation_id required' }, 400);
    await c.env.DB.prepare('DELETE FROM messenger_ratchet_reset_requests WHERE conversation_id = ?').bind(convId).run();
    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Ratchet reset clear error:', error);
    return c.json({ error: 'Failed to clear reset' }, 500);
  }
});

// GET /api/messenger/opks - how many unused one-time prekeys I have left.
// Clients use this to top up their pool (the server cannot mint OPKs because
// the private material is only decryptable with the user's KEK).
msig.get('/messenger/opks', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const row = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messenger_opks WHERE user_id = ? AND claimed_at IS NULL`,
    )
      .bind(userId)
      .first()) as { n?: number } | null;
    return c.json({ count: row?.n ?? 0 });
  } catch (error: unknown) {
    console.error('Messenger opks get error:', error);
    return c.json({ error: 'Failed to count opks' }, 500);
  }
});

// POST /api/messenger/opks - replenish one-time prekeys without re-registering identity.
msig.post('/messenger/opks', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const { opks } = (await c.req.json()) as {
      opks?: Array<{ id: string; pub: string; privEnc: string; privIv: string }>;
    };
    if (!opks || opks.length === 0) return c.json({ error: 'opks required' }, 400);
    const insert = c.env.DB.prepare(
      'INSERT OR REPLACE INTO messenger_opks (id, user_id, pub, priv_enc, priv_iv) VALUES (?, ?, ?, ?, ?)',
    );
    const batch = opks.map((o) => insert.bind(o.id, userId, o.pub, o.privEnc, o.privIv));
    await c.env.DB.batch(batch);
    return c.json({ success: true, added: opks.length });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Messenger opks post error:', error);
    return c.json({ error: 'Failed to add opks', details: err.message || 'Unknown error' }, 500);
  }
});

export default msig;
