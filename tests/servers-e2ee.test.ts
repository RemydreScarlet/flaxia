import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function registerAndLogin(suffix: string): Promise<string> {
  const { cookie } = await seedUserAndLogin(suffix);
  return cookie;
}

async function myId(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } });
  const data = await json(res);
  return (data.user as { id: string }).id;
}

describe('E2EE chat server keys & ciphertext flows', () => {
  beforeEach(resetDb);

  it('stores server channel keys and enforces member-only recipients', async () => {
    const ownerCookie = await registerAndLogin('1');
    const memberCookie = await registerAndLogin('2');
    const ownerId = await myId(ownerCookie);
    const memberId = await myId(memberCookie);

    // Create a server + channel
    const createServerRes = await fetch(`${BASE_URL}/api/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ name: 'Test Server' }),
    });
    assert.equal(createServerRes.status, 200);
    const serverData = await json(createServerRes);
    const serverId = serverData.id as string;

    const createChannelRes = await fetch(`${BASE_URL}/api/servers/${serverId}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ name: 'general' }),
    });
    assert.equal(createChannelRes.status, 200);
    const channelData = await json(createChannelRes);
    const channelId = channelData.id as string;

    // Add the second user as a member
    const addMemberRes = await fetch(`${BASE_URL}/api/servers/${serverId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ memberIds: [memberId] }),
    });
    assert.equal(addMemberRes.status, 200);

    // Owner submits wrapped channel keys for both members (rotation to v2)
    const submitKeysRes = await fetch(`${BASE_URL}/api/servers/${serverId}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        channelId,
        keyVersion: 2,
        boxes: [
          { userId: ownerId, wrappedKey: 'aGVsbG8=', wrappedIv: 'iv1' },
          { userId: memberId, wrappedKey: 'd29ybGQ=', wrappedIv: 'iv2' },
        ],
      }),
    });
    assert.equal(submitKeysRes.status, 200);

    // Member can fetch their own wrapped key
    const keysRes = await fetch(`${BASE_URL}/api/servers/${serverId}/channels/${channelId}/keys`, {
      headers: { Cookie: memberCookie },
    });
    assert.equal(keysRes.status, 200);
    const keysData = (await json(keysRes)).keys as Array<{
      key_version: number;
      wrapped_key: string;
      wrapped_iv: string;
    }>;
    assert.ok(keysData.length >= 1);
    assert.equal(keysData[0].wrapped_key, 'd29ybGQ=');

    // A plain member cannot submit keys for other members
    const forbiddenRes = await fetch(`${BASE_URL}/api/servers/${serverId}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({
        channelId,
        keyVersion: 3,
        boxes: [{ userId: ownerId, wrappedKey: 'aGVsbG8=', wrappedIv: 'iv3' }],
      }),
    });
    assert.equal(forbiddenRes.status, 403);
  });

  it('stores encrypted server channel messages without leaking plaintext', async () => {
    const ownerCookie = await registerAndLogin('3');

    const serverData = await json(
      await fetch(`${BASE_URL}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ name: 'Encrypted Server' }),
      }),
    );
    const serverId = serverData.id as string;
    const channelData = await json(
      await fetch(`${BASE_URL}/api/servers/${serverId}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ name: 'secret' }),
      }),
    );
    const channelId = channelData.id as string;

    // Send an E2EE (ciphertext-only) message
    const sendRes = await fetch(`${BASE_URL}/api/servers/${serverId}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        content: 'CiBjaXBoZXJ0ZXh0IGJhc2U2NA==',
        contentIv: 'aXYtbm9uY2U=',
        encVersion: 1,
        keyVersion: 1,
      }),
    });
    assert.equal(sendRes.status, 200);

    const msgsRes = await fetch(`${BASE_URL}/api/servers/${serverId}/channels/${channelId}/messages?limit=10`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(msgsRes.status, 200);
    const msgsData = (await json(msgsRes)).messages as Array<{
      content: string;
      content_iv: string | null;
      enc_version: number | null;
      key_version: number | null;
    }>;
    assert.equal(msgsData.length, 1);
    assert.equal(msgsData[0].content, 'CiBjaXBoZXJ0ZXh0IGJhc2U2NA==');
    assert.equal(msgsData[0].content_iv, 'aXYtbm9uY2U=');
    assert.equal(msgsData[0].enc_version, 1);
    assert.equal(msgsData[0].key_version, 1);

    // Server list preview must not leak ciphertext
    const listRes = await fetch(`${BASE_URL}/api/servers`, { headers: { Cookie: ownerCookie } });
    const servers = (await json(listRes)).servers as Array<{ last_message: { content: string } | null }>;
    assert.equal(servers[0].last_message?.content, '[Encrypted message]');
  });

  it('bumps group key_version via wrapped key submission', async () => {
    const ownerCookie = await registerAndLogin('5');
    const memberCookie = await registerAndLogin('6');
    const ownerId = await myId(ownerCookie);
    const memberId = await myId(memberCookie);

    const groupData = await json(
      await fetch(`${BASE_URL}/api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ name: 'Secret Group', memberIds: [memberId] }),
      }),
    );
    const groupId = groupData.id as string;

    // Owner rotates group key to v3 for all members
    const submitRes = await fetch(`${BASE_URL}/api/groups/${groupId}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        keyVersion: 3,
        boxes: [
          { userId: ownerId, wrappedKey: 'a2V5MQ==', wrappedIv: 'iv1' },
          { userId: memberId, wrappedKey: 'a2V5Mg==', wrappedIv: 'iv2' },
        ],
      }),
    });
    assert.equal(submitRes.status, 200);

    const detailRes = await fetch(`${BASE_URL}/api/groups/${groupId}`, { headers: { Cookie: memberCookie } });
    assert.equal(detailRes.status, 200);
    const detail = await json(detailRes);
    assert.equal(detail.key_version, 3);

    const keysRes = await fetch(`${BASE_URL}/api/groups/${groupId}/keys`, { headers: { Cookie: memberCookie } });
    const boxes = (await json(keysRes)).keys as Array<{ key_version: number; wrapped_key: string }>;
    assert.ok(boxes.some((b) => b.key_version === 3 && b.wrapped_key === 'a2V5Mg=='));
  });

  it('stores encrypted group messages and hides plaintext in previews', async () => {
    const ownerCookie = await registerAndLogin('7');
    const memberCookie = await registerAndLogin('8');
    const memberId = await myId(memberCookie);

    const groupData = await json(
      await fetch(`${BASE_URL}/api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ name: 'Encrypted Group', memberIds: [memberId] }),
      }),
    );
    const groupId = groupData.id as string;

    const sendRes = await fetch(`${BASE_URL}/api/groups/${groupId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ content: 'c2VjcmV0IGNpcGhlcnRleHQ=', contentIv: 'aXY=', encVersion: 1, keyVersion: 1 }),
    });
    assert.equal(sendRes.status, 200);

    const msgsRes = await fetch(`${BASE_URL}/api/groups/${groupId}/messages?limit=10`, {
      headers: { Cookie: memberCookie },
    });
    const msgs = (await json(msgsRes)).messages as Array<{
      content: string;
      content_iv: string | null;
      enc_version: number | null;
      key_version: number | null;
    }>;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'c2VjcmV0IGNpcGhlcnRleHQ=');
    assert.equal(msgs[0].content_iv, 'aXY=');
    assert.equal(msgs[0].enc_version, 1);

    const listRes = await fetch(`${BASE_URL}/api/groups`, { headers: { Cookie: memberCookie } });
    const groups = (await json(listRes)).groups as Array<{ last_message: { content: string } | null }>;
    assert.equal(groups[0]?.last_message?.content, '[Encrypted message]');
  });

  it('marks encrypted DM messages so previews never leak plaintext', async () => {
    const aCookie = await registerAndLogin('10');
    const bCookie = await registerAndLogin('11');
    const bId = await myId(bCookie);

    const convData = await json(
      await fetch(`${BASE_URL}/api/dm/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aCookie },
        body: JSON.stringify({ userId: bId }),
      }),
    );
    const convId = convData.id as string;

    const sendRes = await fetch(`${BASE_URL}/api/dm/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aCookie },
      body: JSON.stringify({ content: 'ZWNob2VjcnlwdDpmYWtl', contentIv: 'bm9uY2U=', encVersion: 1, keyVersion: 1 }),
    });
    assert.equal(sendRes.status, 200);

    const msgsRes = await fetch(`${BASE_URL}/api/dm/conversations/${convId}/messages?limit=10`, {
      headers: { Cookie: bCookie },
    });
    const msgs = (await json(msgsRes)).messages as Array<{
      content: string;
      content_iv: string | null;
      enc_version: number | null;
      key_version: number | null;
    }>;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content_iv, 'bm9uY2U=');
    assert.equal(msgs[0].enc_version, 1);

    const convsRes = await fetch(`${BASE_URL}/api/dm/conversations`, { headers: { Cookie: bCookie } });
    const convs = (await json(convsRes)).conversations as Array<{
      id: string;
      key_version: number;
      last_message: { content: string } | null;
    }>;
    assert.equal(convs[0].id, convId);
    assert.equal(convs[0].key_version, 1);
    assert.equal(convs[0].last_message?.content, '[Encrypted message]');
  });
});
