import { Hono } from 'hono';
import { extendSession, getSessionToken } from '../../lib/auth';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const me = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/me - check auth state
me.get('/me', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    // Extend session (sliding window) - keep user logged in if active
    const token = getSessionToken(c.req.raw);
    if (token) {
      await extendSession(c.env, token);
    }

    return c.json({
      user: {
        ...user,
        ng_words: JSON.parse(user.ng_words ?? '[]') as string[],
      },
    });
  } catch (error: unknown) {
    console.error('Auth check error:', error);
    return c.json({ error: 'Auth check failed' }, 500);
  }
});

export default me;
