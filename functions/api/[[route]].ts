import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getMeWithSession, getSession, getSessionToken, User } from '../lib/auth';
import activitypubRouter from './routes/activitypub';
import adminRouter from './routes/admin';
import adsRouter from './routes/ads';
import authRouter from './routes/auth';
import callsRouter from './routes/calls';
import topicRouter from './routes/current-topic';
import gamesRouter from './routes/games';
import groupsRouter from './routes/groups';
import linkPreviewRouter from './routes/link-preview';
import meRouter from './routes/me';
import mediaRouter from './routes/media';
import messengerRouter from './routes/messenger';
import msigRouter from './routes/msig';
import multiplayerRouter from './routes/multiplayer';
import pollsRouter from './routes/polls';
import postsRouter from './routes/posts';
import pushRouter from './routes/push';
import reportRouter from './routes/report';
import serversRouter from './routes/servers';
import stampsRouter from './routes/stamps';
import tagsRouter from './routes/tags';
import testsRouter from './routes/tests';
import usersRouter from './routes/users';

type Bindings = {
  DB: D1Database;
  DB_TEST: D1Database;
  BUCKET: R2Bucket;
  CACHE: KVNamespace;
  SANDBOX_ORIGIN: string;
  BASE_URL: string;
  ADMIN_USERNAMES: string;
  AP_DELIVERY_QUEUE: Queue;
  CROWD_ORCHESTRATOR_URL: string;
  CROWD_API_KEY: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  CF_ACCESS_AUD: string;
  CF_TEAM_DOMAIN: string;
  CROWD_ORCHESTRATOR?: Fetcher;
  NOTIFICATION_STREAM?: DurableObjectNamespace;
  CALL_STREAM?: DurableObjectNamespace;
  MULTIPLAYER_ROOM?: DurableObjectNamespace;
  MATCHMAKER?: DurableObjectNamespace;
  FCM_SERVER_KEY?: string;
  VECTORIZE?: Vectorize;
};

type Variables = {
  user: User | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Auth middleware — sets user context (null if not authenticated); must precede all routes
app.use('/api/*', async (c, next) => {
  if (
    (c.req.method === 'GET' && c.req.path.startsWith('/api/images/')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/audio/')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/video/')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/zip/')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/swf/')) ||
    (c.req.method === 'GET' && c.req.path === '/api/link-preview') ||
    (c.req.method === 'GET' && c.req.path === '/api/games') ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/ads/') && c.req.path.endsWith('/payload')) ||
    (c.req.method === 'GET' && c.req.path.startsWith('/api/wvfs-zip/'))
  ) {
    await next();
    return;
  }
  const token = getSessionToken(c.req.raw);
  const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
  c.set('user', sessionData?.user || null);
  await next();
});

app.use(
  '/*',
  cors({
    origin: (origin, c) => {
      if (!origin) return '';
      const env = c.env as { BASE_URL?: string; SANDBOX_ORIGIN?: string };
      const allowed = new Set(
        [
          env.BASE_URL,
          env.SANDBOX_ORIGIN,
          'http://localhost:8787',
          'http://localhost:5173',
          'https://flaxia.app',
          'https://sandbox.flaxia.app',
        ].filter(Boolean),
      );
      return allowed.has(origin) ? origin : '';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

const allowedOrigins = new Set([
  'http://localhost:8787',
  'http://localhost:5173',
  'https://flaxia.app',
  'https://sandbox.flaxia.app',
]);

function getBaseOrigin(c: any): string {
  try {
    return new URL(c.env.BASE_URL || 'https://flaxia.app').origin;
  } catch {
    return 'https://flaxia.app';
  }
}

const csrfProtection = async (c: any, next: any) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }
  const origin = c.req.header('Origin');
  if (origin) {
    const baseOrigin = getBaseOrigin(c);
    if (!allowedOrigins.has(origin) && origin !== baseOrigin) {
      return c.json({ error: 'CSRF validation failed' }, 403);
    }
  }
  await next();
};

app.use('/*', csrfProtection);

// Auth routes (extracted to routes/auth.ts)
app.route('/api/auth', authRouter);

// Media routes (extracted to routes/media.ts)
app.route('/api', mediaRouter);

// User routes (extracted to routes/users.ts)
app.route('/api', usersRouter);

// Poll routes (extracted to routes/polls.ts)
app.route('/api', pollsRouter);

// Stamp routes (extracted to routes/stamps.ts)
app.route('/api', stampsRouter);

// Tag routes (extracted to routes/tags.ts)
app.route('/api', tagsRouter);

// Link-preview routes (extracted to routes/link-preview.ts)
app.route('/api', linkPreviewRouter);

// Current-topic route (extracted to routes/current-topic.ts)
app.route('/api', topicRouter);

// Report route (extracted to routes/report.ts)
app.route('/api', reportRouter);

// Group routes (extracted to routes/groups.ts)
app.route('/api', groupsRouter);

// Messenger E2EE signal routes (extracted to routes/msig.ts)
app.route('/api', msigRouter);

// Auth/me routes (extracted to routes/me.ts)
app.route('/api', meRouter);

// Ad routes (extracted to routes/ads.ts)
app.route('/api', adsRouter);

// Game routes (extracted to routes/games.ts)
app.route('/api', gamesRouter);

// Post routes (extracted to routes/posts.ts)
app.route('/api', postsRouter);

export async function onRequest(context: Record<string, unknown>) {
  const request = context.request as Request;
  const env = context.env as Bindings;

  // WebSocket 通知ストリーム — デスクトップアプリからの接続を受け付ける
  const url = new URL(request.url);
  if (url.pathname === '/api/ws/notifications' && request.headers.get('Upgrade') === 'websocket') {
    const sessionToken = getSessionToken(request) || url.searchParams.get('token');
    if (!sessionToken) return new Response('Unauthorized', { status: 401 });
    const session = await getSession(env, sessionToken);
    if (!session) return new Response('Unauthorized', { status: 401 });

    if (!env.NOTIFICATION_STREAM) return new Response('Notifications not available', { status: 503 });
    const doId = env.NOTIFICATION_STREAM.idFromName(session.user.id);
    const stub = env.NOTIFICATION_STREAM.get(doId);
    return stub.fetch(request);
  }

  // WebSocket 通話シグナリングストリーム
  if (url.pathname === '/api/ws/call' && request.headers.get('Upgrade') === 'websocket') {
    const roomId = url.searchParams.get('roomId');
    if (!roomId) return new Response('Missing roomId', { status: 400 });

    const sessionToken = getSessionToken(request) || url.searchParams.get('token');
    if (!sessionToken) return new Response('Unauthorized', { status: 401 });
    const session = await getSession(env, sessionToken);
    if (!session) return new Response('Unauthorized', { status: 401 });

    // Build forward URL with user info for the DO
    const forwardUrl = new URL(request.url);
    forwardUrl.searchParams.set('userId', session.user.id);
    forwardUrl.searchParams.set('username', session.user.username || '');
    forwardUrl.searchParams.set('display_name', session.user.display_name || '');
    forwardUrl.searchParams.set('avatar_key', session.user.avatar_key || '');

    const forwardReq = new Request(forwardUrl.toString(), {
      headers: request.headers,
    });

    if (!env.CALL_STREAM) return new Response('Calls not available', { status: 503 });
    const doId = env.CALL_STREAM.idFromName(roomId);
    const stub = env.CALL_STREAM.get(doId);
    return stub.fetch(forwardReq);
  }

  // WebSocket マルチプレイヤールーム
  if (url.pathname === '/api/ws/multiplayer' && request.headers.get('Upgrade') === 'websocket') {
    const roomId = url.searchParams.get('roomId');
    const gameId = url.searchParams.get('gameId');
    if (!roomId || !gameId) return new Response('Missing roomId or gameId', { status: 400 });

    const sessionToken = getSessionToken(request) || url.searchParams.get('token');
    if (!sessionToken) return new Response('Unauthorized', { status: 401 });
    const session = await getSession(env, sessionToken);
    if (!session) return new Response('Unauthorized', { status: 401 });

    const forwardUrl = new URL(request.url);
    forwardUrl.searchParams.set('userId', session.user.id);
    forwardUrl.searchParams.set('username', session.user.username || '');
    forwardUrl.searchParams.set('display_name', session.user.display_name || '');
    forwardUrl.searchParams.set('avatar_key', session.user.avatar_key || '');
    forwardUrl.searchParams.set('gameId', gameId);
    forwardUrl.searchParams.set('roomId', roomId);

    const forwardReq = new Request(forwardUrl.toString(), {
      headers: request.headers,
    });

    if (!env.MULTIPLAYER_ROOM) return new Response('Multiplayer not available', { status: 503 });
    const doId = env.MULTIPLAYER_ROOM.idFromName(roomId);
    const stub = env.MULTIPLAYER_ROOM.get(doId);
    return stub.fetch(forwardReq);
  }

  return app.fetch(request, env as unknown as Record<string, unknown>, context as unknown as ExecutionContext);
}
