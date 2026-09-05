import { Hono } from 'hono';
import { createMediaToken, type MediaType } from '../../lib/media-signing';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const mediaToken = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/media-token/:type/:key — issue a signed token for a media resource
mediaToken.get('/media-token/:type/:key', requireAuth, async (c) => {
  try {
    const type = c.req.param('type') as MediaType;
    const key = c.req.param('key');

    if (!key) {
      return c.json({ error: 'Missing key' }, 400);
    }

    const validTypes: MediaType[] = ['image', 'audio', 'video', 'swf', 'zip'];
    if (!validTypes.includes(type)) {
      return c.json({ error: 'Invalid media type' }, 400);
    }

    // Validate that the key corresponds to an existing resource
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const object = await c.env.BUCKET.head(key);
    if (!object) {
      return c.json({ error: 'Media not found' }, 404);
    }

    const token = await createMediaToken(c.env, key, type);

    return c.json({ token, expiresIn: type === 'image' ? 300 : type === 'swf' || type === 'zip' ? 3600 : 1800 });
  } catch (error: unknown) {
    console.error('Media token error:', error);
    return c.json({ error: 'Failed to generate token' }, 500);
  }
});

// GET /api/media-token/batch — issue tokens for multiple media resources at once
mediaToken.post('/media-token/batch', requireAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { items: Array<{ type: MediaType; key: string }> };

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return c.json({ error: 'Missing items' }, 400);
    }

    if (body.items.length > 50) {
      return c.json({ error: 'Too many items (max 50)' }, 400);
    }

    const validTypes: MediaType[] = ['image', 'audio', 'video', 'swf', 'zip'];
    const results: Array<{ key: string; token: string; expiresIn: number }> = [];

    for (const item of body.items) {
      if (!validTypes.includes(item.type) || !item.key) continue;

      const token = await createMediaToken(c.env, item.key, item.type);
      const expiresIn = item.type === 'image' ? 300 : item.type === 'swf' || item.type === 'zip' ? 3600 : 1800;
      results.push({ key: item.key, token, expiresIn });
    }

    return c.json({ items: results });
  } catch (error: unknown) {
    console.error('Media batch token error:', error);
    return c.json({ error: 'Failed to generate tokens' }, 500);
  }
});

export default mediaToken;
