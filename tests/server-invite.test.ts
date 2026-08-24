import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function createServer(cookie: string): Promise<{ id: string; generalChannelId: string; keyVersion: number }> {
  const res = await fetch(`${BASE_URL}/api/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Test Server', description: 'desc' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { id: string; general_channel_id: string };
  // Fetch channels to learn the key version.
  const srv = (await json(await fetch(`${BASE_URL}/api/servers/${data.id}`, { headers: { Cookie: cookie } }))) as {
    channels: Array<{ id: string; key_version: number }>;
  };
  return { id: data.id, generalChannelId: data.general_channel_id, keyVersion: srv.channels[0]?.key_version ?? 1 };
}

describe('Server invite links + E2EE key distribution', () => {
  beforeEach(resetDb);

  it('creates, resolves, and joins via an invite link', async () => {
    const owner = await seedUserAndLogin('inv-owner');
    const server = await createServer(owner.cookie);

    // Owner creates an invite.
    const create = await fetch(`${BASE_URL}/api/servers/${server.id}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(create.status, 200);
    const invite = (await json(create)) as { token: string; url: string };
    assert.match(invite.url, /^\/invite\//);

    // Public resolve works without auth.
    const resolve = (await json(await fetch(`${BASE_URL}/api/servers/invite/${invite.token}`))) as {
      serverName: string;
      expired: boolean;
      usedUp: boolean;
    };
    assert.equal(resolve.serverName, 'Test Server');
    assert.equal(resolve.expired, false);
    assert.equal(resolve.usedUp, false);

    // A second user joins via the invite.
    const joiner = await seedUserAndLogin('inv-joiner');
    const join = await fetch(`${BASE_URL}/api/servers/invite/${invite.token}/join`, {
      method: 'POST',
      headers: { Cookie: joiner.cookie },
    });
    assert.equal(join.status, 200);
    const joined = (await json(join)) as { serverId: string };
    assert.equal(joined.serverId, server.id);

    // Joiner is now a member and can read server detail.
    const srv = (await json(
      await fetch(`${BASE_URL}/api/servers/${server.id}`, { headers: { Cookie: joiner.cookie } }),
    )) as { member_count: number };
    assert.ok(srv.member_count >= 2);
  });

  it('rejects joining with an unknown token', async () => {
    const joiner = await seedUserAndLogin('inv-bad');
    const res = await fetch(`${BASE_URL}/api/servers/invite/does-not-exist/join`, {
      method: 'POST',
      headers: { Cookie: joiner.cookie },
    });
    assert.equal(res.status, 404);
  });

  it('enforces usage limit and expiry, and supports revoke', async () => {
    const owner = await seedUserAndLogin('inv-limit-owner');
    const server = await createServer(owner.cookie);

    const create = await fetch(`${BASE_URL}/api/servers/${server.id}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ maxUses: 1 }),
    });
    const invite = (await json(create)) as { token: string };

    const joiner = await seedUserAndLogin('inv-limit-joiner');
    const join = await fetch(`${BASE_URL}/api/servers/invite/${invite.token}/join`, {
      method: 'POST',
      headers: { Cookie: joiner.cookie },
    });
    assert.equal(join.status, 200);

    // Second use exceeds the limit.
    const joiner2 = await seedUserAndLogin('inv-limit-joiner2');
    const join2 = await fetch(`${BASE_URL}/api/servers/invite/${invite.token}/join`, {
      method: 'POST',
      headers: { Cookie: joiner2.cookie },
    });
    assert.equal(join2.status, 410);

    // Revoke makes the invite unusable / unresolvable.
    const revoke = await fetch(`${BASE_URL}/api/servers/${server.id}/invites/${invite.token}`, {
      method: 'DELETE',
      headers: { Cookie: owner.cookie },
    });
    assert.equal(revoke.status, 200);

    const resolve = await fetch(`${BASE_URL}/api/servers/invite/${invite.token}`);
    assert.equal(resolve.status, 404);
  });

  it('lets a key-holding member wrap the channel key for a new invitee (E2EE)', async () => {
    const owner = await seedUserAndLogin('inv-e2ee-owner');
    const server = await createServer(owner.cookie);

    const joiner = await seedUserAndLogin('inv-e2ee-joiner');
    const create = await fetch(`${BASE_URL}/api/servers/${server.id}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({}),
    });
    const invite = (await json(create)) as { token: string };
    await fetch(`${BASE_URL}/api/servers/invite/${invite.token}/join`, {
      method: 'POST',
      headers: { Cookie: joiner.cookie },
    });

    const joinerId = (await json(await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: joiner.cookie } }))) as {
      user: { id: string };
    };

    // Owner (a key-holding member) wraps a dummy channel key box for the joiner.
    const submit = await fetch(`${BASE_URL}/api/servers/${server.id}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({
        channelId: server.generalChannelId,
        keyVersion: server.keyVersion,
        boxes: [{ userId: joinerId.user.id, wrappedKey: 'wrappedA', wrappedIv: 'ivA' }],
      }),
    });
    assert.equal(submit.status, 200);

    // The joiner can fetch their wrapped box; the server never sees the plaintext key.
    const keys = (await json(
      await fetch(`${BASE_URL}/api/servers/${server.id}/channels/${server.generalChannelId}/keys`, {
        headers: { Cookie: joiner.cookie },
      }),
    )) as { keys: Array<{ wrapped_key: string; wrapped_iv: string }> };
    assert.ok(keys.keys.length >= 1);
    assert.equal(keys.keys[0].wrapped_key, 'wrappedA');
  });
});
