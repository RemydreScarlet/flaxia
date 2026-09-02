import { FlaxiaClient } from '@flaxia/sdk';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { nanoid } from 'nanoid';
import { isAdmin } from '../../src/lib/admin';
import { copyHtmlToWvfs, extractFileFromZip, extractZipToR2 } from '../../src/lib/wvfs-zip-server';
import type { ReportCategory } from '../../src/types/post';
import { deleteAccount } from '../lib/account-deletion';
import { buildCreateActivity, buildDeleteActivity, buildNoteObject } from '../lib/activitypub/note';
import {
  deleteSession,
  extendSession,
  getMeWithSession,
  getSession,
  getSessionToken,
  hashPassword,
  User,
  verifyPassword,
  verifySrpPassword,
} from '../lib/auth';
import { validateImageDimensions } from '../lib/image-dimensions';
import {
  type BanditPrior,
  applyReward as banditApplyReward,
  computeScore as banditComputeScore,
  project as banditProject,
  createProjection,
  createState,
  createStateFromPrior,
  eventReward,
  type LinUCBConfig,
  type LinUCBState,
  parseBanditConfig,
  parseBanditPrior,
  projConfigKey,
  serializeState,
} from '../lib/linucb';
import { sendPushToAll } from '../lib/notify';
import { computeAuthorQuality, computeQualityScore, freshnessBoost, getTypeWeights } from '../lib/scoring';
import { batchGetFreshAndBookmarkStatus, detectMimeType, isAllowedImageMime } from './helpers';
import activitypubRouter from './routes/activitypub';
import adminRouter from './routes/admin';
import authRouter from './routes/auth';
import callsRouter from './routes/calls';
import mediaRouter from './routes/media';
import messengerRouter from './routes/messenger';
import multiplayerRouter from './routes/multiplayer';
import pollsRouter from './routes/polls';
import pushRouter from './routes/push';
import serversRouter from './routes/servers';
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

type PostRow = {
  id: string;
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_key?: string | null;
  text: string;
  hashtags: string;
  mentions: string;
  gif_key: string | null;
  payload_key: string | null;
  swf_key: string | null;
  thumbnail_key: string | null;
  game_description?: string | null;
  parent_id: string | null;
  root_id: string | null;
  depth: number;
  fresh_count: number;
  bookmark_count: number;
  reply_count: number;
  impressions: number;
  status: string;
  hidden: number;
  author_language?: string | null;
  actor_id: string | null;
  created_at: string;
  quoted_post_id?: string | null;
  quoted_post?: Record<string, unknown> | null;
  is_freshed?: boolean;
  is_bookmarked?: boolean;
  reactions?: Array<{ emoji: string; count: number; reacted: boolean }>;
  poll?: {
    id: string;
    question: string;
    multipleChoice: boolean;
    endsAt?: string | null;
    ended_notified?: number;
    expired: boolean;
    options: Array<{ id: string; label: string; votes_count: number }>;
    userVote: string | null;
  };
};

type PollRow = {
  id: string;
  post_id: string;
  question: string;
  multiple_choice: number;
  ends_at: string | null;
  ended_notified: number;
};

type PollOptionRow = {
  id: string;
  poll_id: string;
  label: string;
  votes_count: number;
};

type WebfingerData = {
  links?: Array<{ rel: string; href?: string; type?: string }>;
};

type ActorData = {
  inbox?: string;
  publicKey?: { publicKeyPem?: string };
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

const requireAuth = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  if (!c.get('user')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

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

const embeddingPosts = new Set<string>();
let lastEmbedTime = 0;
const EMBED_RATE_LIMIT_MS = 10_000;
const PENDING_EMBED_MAX_ATTEMPTS = 5;

// Persist a post for later vector-embed submission. Used instead of silently
// dropping when the crowd pipeline is rate-limited, unconfigured, or failed, so
// no post is ever lost from the recommendation candidate pool.
async function enqueuePendingEmbed(
  db: D1Database | undefined,
  postId: string,
  text: string,
  attempts = 0,
  error?: string,
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO pending_embeddings (post_id, text, attempts, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(post_id) DO UPDATE SET
           attempts = excluded.attempts,
           last_error = excluded.last_error`,
      )
      .bind(postId, text, attempts, error ?? null)
      .run();
  } catch (e) {
    console.error(`Failed to enqueue pending embed for post ${postId}:`, e);
  }
}

// Submit a single vector-embed task to the crowd orchestrator. Sets the shared
// throttle timestamp on success so real-time traffic stays gentle on the queue.
async function submitEmbedTask(
  orchestratorUrl: string,
  apiKey: string,
  baseUrl: string,
  postId: string,
  text: string,
): Promise<boolean> {
  const normalizedUrl = orchestratorUrl.replace(/\/+$/, '');
  if (!normalizedUrl || !apiKey) return false;

  const client = new FlaxiaClient({ baseUrl: `${normalizedUrl}/crowd`, apiKey });
  const callbackUrl = `${baseUrl || 'https://flaxia.app'}/api/crowd/webhook?type=vector-embed&postId=${postId}`;
  try {
    await client.submit({
      workload: 'vector-embed',
      payload: { text },
      callbackUrl,
      timeoutMs: 600000,
    } as never);
    lastEmbedTime = Date.now();
    console.log(`Embedding task submitted for post ${postId}`);
    return true;
  } catch (err) {
    console.error(`Embedding submission failed for post ${postId}:`, err);
    return false;
  }
}

// Drain the pending_embeddings outbox. `respectThrottle` keeps the 10s ceiling
// for real-time traffic; the admin backfill may pass false to make progress on
// a large backlog. Failed submissions are kept (attempts++) instead of dropped.
async function drainPendingEmbeds(
  db: D1Database,
  orchestratorUrl: string,
  apiKey: string,
  baseUrl: string,
  opts: { maxBatch?: number; delayMs?: number; respectThrottle?: boolean } = {},
): Promise<{ submitted: number; remaining: number }> {
  const { maxBatch = 10, delayMs = 0, respectThrottle = true } = opts;
  if (!orchestratorUrl || !apiKey) {
    const { total } = (await db
      .prepare('SELECT COUNT(*) as total FROM pending_embeddings')
      .first<{ total: number }>()) || { total: 0 };
    return { submitted: 0, remaining: total };
  }

  const rows = await db
    .prepare(
      `SELECT post_id, text, attempts FROM pending_embeddings
       WHERE attempts < ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(PENDING_EMBED_MAX_ATTEMPTS, maxBatch)
    .all<{ post_id: string; text: string; attempts: number }>();

  let submitted = 0;
  for (const row of rows.results || []) {
    if (embeddingPosts.has(row.post_id)) continue;
    if (respectThrottle && Date.now() - lastEmbedTime < EMBED_RATE_LIMIT_MS) break;

    const ok = await submitEmbedTask(orchestratorUrl, apiKey, baseUrl, row.post_id, row.text);
    if (ok) {
      await db.prepare('DELETE FROM pending_embeddings WHERE post_id = ?').bind(row.post_id).run();
      submitted++;
    } else {
      await enqueuePendingEmbed(db, row.post_id, row.text, row.attempts + 1, 'submission failed');
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  const { total } = (await db
    .prepare('SELECT COUNT(*) as total FROM pending_embeddings')
    .first<{ total: number }>()) || { total: 0 };
  return { submitted, remaining: total };
}

async function embedPost(
  db: D1Database | undefined,
  orchestratorUrl: string,
  apiKey: string,
  baseUrl: string,
  postId: string,
  text: string,
): Promise<void> {
  if (embeddingPosts.has(postId)) return;
  embeddingPosts.add(postId);
  try {
    if (!orchestratorUrl || !apiKey) {
      // Crowd not configured: persist so a later backfill can pick it up.
      await enqueuePendingEmbed(db, postId, text);
      return;
    }

    // Best-effort drain of any backlog first (respects the rate limit).
    if (db) {
      await drainPendingEmbeds(db, orchestratorUrl, apiKey, baseUrl).catch((e) =>
        console.error('Pending embed drain failed:', e),
      );
    }

    // Submit the new post; if rate-limited or failed, enqueue instead of dropping.
    if (Date.now() - lastEmbedTime < EMBED_RATE_LIMIT_MS) {
      await enqueuePendingEmbed(db, postId, text);
      return;
    }
    const ok = await submitEmbedTask(orchestratorUrl, apiKey, baseUrl, postId, text);
    if (!ok) await enqueuePendingEmbed(db, postId, text, 1, 'submission failed');
  } finally {
    embeddingPosts.delete(postId);
  }
}

const IMAGE_KEY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const _IMAGE_EXTENSION_LIKE = IMAGE_KEY_EXTENSIONS.map((ext) => `(lower(gif_key) LIKE '%${ext}')`).join(' OR ');

const nsfwScanPosts = new Set<string>();
let lastNsfwSubmitTime = 0;
const NSFW_RATE_LIMIT_MS = 10_000;

const NSFW_SCAN_SCHEMA = `post_id TEXT PRIMARY KEY, task_id TEXT, status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'done', 'failed')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), scanned_at TEXT`;

const PENDING_EMBEDS_SCHEMA = `post_id TEXT PRIMARY KEY, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_error TEXT`;

async function ensureNsfwScansTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS post_nsfw_scans (${NSFW_SCAN_SCHEMA})`).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_nsfw_scans_status ON post_nsfw_scans(status, created_at)').run();
  } catch (e) {
    console.error('Failed to ensure post_nsfw_scans table:', e);
  }
}

// The test dev server provisions its DB_TEST binding without migrations, so
// ensure the outbox table exists before touching it there (mirrors
// ensureNsfwScansTable).
async function _ensurePendingEmbedsTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS pending_embeddings (${PENDING_EMBEDS_SCHEMA})`).run();
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_pending_embeddings_created ON pending_embeddings(created_at)')
      .run();
  } catch (e) {
    console.error('Failed to ensure pending_embeddings table:', e);
  }
}

// The test dev server provisions its DB_TEST binding without migrations, so
// ensure the reactions table exists before touching it there (mirrors
// ensureNsfwScansTable).
async function ensureReactionsTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS reactions (
           post_id    TEXT NOT NULL,
           user_id    TEXT NOT NULL,
           emoji      TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           PRIMARY KEY (post_id, user_id, emoji)
         )`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id)').run();
  } catch (e) {
    console.error('Failed to ensure reactions table:', e);
  }
}

async function ensureCustomStampsTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS custom_stamps (
           id         TEXT PRIMARY KEY,
           user_id    TEXT NOT NULL REFERENCES users(id),
           name       TEXT NOT NULL,
           image_key  TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         )`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_custom_stamps_user ON custom_stamps(user_id)').run();
    await db
      .prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_stamps_user_name ON custom_stamps(user_id, name)')
      .run();
  } catch (e) {
    console.error('Failed to ensure custom_stamps table:', e);
  }
}

async function markNsfwScan(db: D1Database, postId: string, status: string, taskId?: string): Promise<void> {
  try {
    if (status === 'submitted') {
      await db
        .prepare('INSERT OR IGNORE INTO post_nsfw_scans (post_id, status) VALUES (?, ?)')
        .bind(postId, status)
        .run();
    } else {
      await db
        .prepare('UPDATE post_nsfw_scans SET status = ?, scanned_at = ? WHERE post_id = ?')
        .bind(status, new Date().toISOString(), postId)
        .run();
    }
    if (taskId && status === 'submitted') {
      await db.prepare('UPDATE post_nsfw_scans SET task_id = ? WHERE post_id = ?').bind(taskId, postId).run();
    }
  } catch (e) {
    console.error(`Failed to record NSFW scan state for post ${postId}:`, e);
  }
}

// Screens an image post/reply with the NudeNet crowd workload. Skips non-image
// keys, already-scanned posts, and enforces a simple global rate limit to avoid
// flooding the orchestrator when many posts commit back-to-back.
async function submitDetectNsfw(
  db: D1Database,
  orchestratorUrl: string,
  apiKey: string,
  baseUrl: string,
  postId: string,
  gifKey: string | null,
): Promise<void> {
  const normalizedUrl = orchestratorUrl.replace(/\/+$/, '');
  if (!normalizedUrl || !apiKey || !gifKey) return;

  const lower = gifKey.toLowerCase();
  if (!IMAGE_KEY_EXTENSIONS.some((ext) => lower.endsWith(ext))) return;

  if (nsfwScanPosts.has(postId)) return;
  nsfwScanPosts.add(postId);

  const now = Date.now();
  if (now - lastNsfwSubmitTime < NSFW_RATE_LIMIT_MS) {
    nsfwScanPosts.delete(postId);
    return;
  }
  lastNsfwSubmitTime = now;

  try {
    await ensureNsfwScansTable(db);

    const existing = (await db
      .prepare('SELECT status FROM post_nsfw_scans WHERE post_id = ?')
      .bind(postId)
      .first()) as { status: string } | null;
    if (existing?.status === 'done') return;

    const client = new FlaxiaClient({ baseUrl: `${normalizedUrl}/crowd`, apiKey });
    const callbackUrl = `${baseUrl || 'https://flaxia.app'}/api/crowd/webhook?type=nsfw&postId=${postId}`;
    const res = await client.submit({
      workload: 'nudenet',
      payload: { imageUrl: `${baseUrl || 'https://flaxia.app'}/api/images/${gifKey}` },
      callbackUrl,
      timeoutMs: 120000,
    } as never);
    await markNsfwScan(db, postId, 'submitted', res.taskId);
    console.log(`NSFW detection task submitted for post ${postId} (task ${res.taskId})`);
  } catch (err) {
    console.error(`NSFW detection submission failed for post ${postId}:`, err);
  } finally {
    nsfwScanPosts.delete(postId);
  }
}

// KV cache helpers for API response caching
async function kvCacheGet<T>(c: any, key: string): Promise<T | null> {
  try {
    const raw = await c.env.CACHE?.get(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // proceed without cache on KV failure
  }
  return null;
}

async function kvCacheSet(c: any, key: string, data: unknown, ttl: number): Promise<void> {
  try {
    await c.env.CACHE?.put(key, JSON.stringify(data), { expirationTtl: ttl });
  } catch (e) {
    console.warn('KV cache write failed:', e);
  }
}

// includeUser=false makes the key user-agnostic so logged-in users share the
// cache. Only safe for feeds whose result set is user-independent; per-user
// filtering (e.g. block lists) must then be applied on cache read.
function makeCacheKey(prefix: string, c: any, extra?: string, includeUser = true): string {
  const token = getSessionToken(c.req.raw);
  const userId = token ? token.substring(0, 12) : 'anon';
  const query = c.req.raw.url.split('?')[1] || '';
  const userPart = includeUser ? userId : '';
  return `${prefix}:${userPart}:${query}${extra ? ':' + extra : ''}`;
}

// Apply the current user's block list to a post list in JS so user-agnostic
// caches can be shared across users without baking one user's blocks into them.
async function filterBlockedAuthors(
  db: D1Database,
  currentUserId: string | null | undefined,
  posts: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (!currentUserId || posts.length === 0) return posts;
  const blockedResult = await db
    .prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?')
    .bind(currentUserId)
    .all<{ blocked_id: string }>();
  if (!blockedResult.success || blockedResult.results.length === 0) return posts;
  const blocked = new Set(blockedResult.results.map((r) => r.blocked_id));
  return posts.filter((p) => !blocked.has(String(p.user_id)));
}

// GET /api/ads/:id/payload - serve ad payloads from R2
app.get('/api/ads/:id/payload', async (c) => {
  try {
    const adId = c.req.param('id');

    if (!adId) {
      return c.json({ error: 'Missing ad ID' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // Fetch ad to get payload_key, payload_type, and thumbnail_key
    const ad = await c.env.DB.prepare('SELECT payload_key, payload_type, thumbnail_key FROM ads WHERE id = ?')
      .bind(adId)
      .first();

    if (!ad) {
      return c.json({ error: 'Ad not found' }, 404);
    }

    if (!ad.payload_key) {
      return c.json({ error: 'No payload available' }, 404);
    }

    // Get object from R2
    const object = await c.env.BUCKET.get(ad.payload_key as string);

    if (!object) {
      return c.json({ error: 'Payload not found' }, 404);
    }

    // Determine content type based on payload_type
    let contentType = 'application/octet-stream';
    switch (ad.payload_type) {
      case 'zip':
        contentType = 'application/zip';
        break;
      case 'swf':
        contentType = 'application/x-shockwave-flash';
        break;
      case 'gif':
        contentType = 'image/gif';
        break;
      case 'image':
        // Detect from key extension
        const extension = (ad.payload_key as string).split('.').pop()?.toLowerCase();
        if (extension === 'png') {
          contentType = 'image/png';
        } else if (extension === 'jpg' || extension === 'jpeg') {
          contentType = 'image/jpeg';
        } else if (extension === 'gif') {
          contentType = 'image/gif';
        } else if (extension === 'webp') {
          contentType = 'image/webp';
        }
        break;
    }

    // Return the payload with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': 'https://flaxia.app',
      },
    });
  } catch (error: unknown) {
    console.error('Ad payload error:', error);
    return c.json({ error: 'Failed to fetch ad payload' }, 500);
  }
});

// Helper functions for link preview
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function parseMetaTags(html: string, baseUrl: string) {
  const result = {
    title: '',
    description: '',
    image: '',
    siteName: '',
    url: baseUrl,
    type: '',
    video: {
      url: '',
      secureUrl: '',
      type: '',
      width: 0,
      height: 0,
    },
  };

  const matchMeta = (property: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const matchMetaName = (name: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const resolveUrl = (url: string): string => {
    if (url.startsWith('//')) {
      try {
        return new URL(url, baseUrl).toString();
      } catch {}
    } else if (url.startsWith('/') || url.startsWith('.')) {
      try {
        return new URL(url, baseUrl).toString();
      } catch {}
    }
    return url;
  };

  // 1. Title
  const ogTitle = matchMeta('og:title') || matchMetaName('twitter:title');
  if (ogTitle) {
    result.title = decodeHtmlEntities(ogTitle);
  } else {
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag) {
      result.title = decodeHtmlEntities(titleTag[1].trim());
    }
  }

  // 2. Description
  const ogDesc = matchMeta('og:description') || matchMetaName('description') || matchMetaName('twitter:description');
  if (ogDesc) {
    result.description = decodeHtmlEntities(ogDesc);
  }

  // 3. Image
  const ogImage = matchMeta('og:image') || matchMetaName('twitter:image');
  if (ogImage) {
    result.image = resolveUrl(ogImage);
  }

  // 4. Site Name
  const ogSiteName = matchMeta('og:site_name');
  if (ogSiteName) {
    result.siteName = decodeHtmlEntities(ogSiteName);
  } else {
    try {
      result.siteName = new URL(baseUrl).hostname;
    } catch {}
  }

  // 5. og:type
  const ogType = matchMeta('og:type');
  if (ogType) {
    result.type = ogType;
  }

  // 6. Video embed info
  const ogVideoUrl = matchMeta('og:video:url') || matchMeta('og:video');
  const ogVideoSecureUrl = matchMeta('og:video:secure_url');
  const ogVideoType = matchMeta('og:video:type');
  const ogVideoWidth = matchMeta('og:video:width');
  const ogVideoHeight = matchMeta('og:video:height');

  if (ogVideoUrl) {
    result.video.url = resolveUrl(ogVideoUrl);
  }
  if (ogVideoSecureUrl) {
    result.video.secureUrl = ogVideoSecureUrl;
  }
  if (ogVideoType) {
    result.video.type = ogVideoType;
  }
  if (ogVideoWidth) {
    result.video.width = parseInt(ogVideoWidth, 10) || 0;
  }
  if (ogVideoHeight) {
    result.video.height = parseInt(ogVideoHeight, 10) || 0;
  }

  return result;
}

function isPrivateIP(hostname: string): boolean {
  // IPv4
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]].map(Number);
    if (octets.some((o) => o > 255)) return true;
    const [a, b] = octets;
    // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10 (CGNAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 198.18.0.0/15
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  // IPv6
  if (hostname.includes(':') && hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.includes(':')) {
    const normalized = hostname.toLowerCase();
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  }
  return false;
}

function isInternalHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase();
  // Strip trailing dot for FQDN
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  const internalNames = new Set([
    'localhost',
    'localhost.localdomain',
    'local',
    'broadcasthost',
    'metadata.google.internal',
    'metadata',
    '169.254.169.254',
  ]);
  if (internalNames.has(name)) return name;
  // Block any hostname ending in .internal, .local, .localhost
  if (name.endsWith('.internal') || name.endsWith('.local') || name.endsWith('.localhost')) return name;
  return null;
}

function checkSSRF(url: URL): string | null {
  const hostname = url.hostname;
  // Strip brackets from IPv6
  const cleanHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isPrivateIP(cleanHost)) return 'Requests to private IP addresses are not allowed';
  const internal = isInternalHostname(hostname);
  if (internal) return `Requests to ${internal} are not allowed`;
  return null;
}

// GET /api/link-preview - Scrape OpenGraph meta tags of a URL
app.get('/api/link-preview', async (c) => {
  const urlString = c.req.query('url');
  if (!urlString) {
    return c.json({ error: 'Missing url parameter' }, 400);
  }

  try {
    const targetUrl = new URL(urlString);
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return c.json({ error: 'Invalid protocol' }, 400);
    }

    const blockedHost = checkSSRF(targetUrl);
    if (blockedHost) {
      return c.json({ error: blockedHost }, 400);
    }

    const response = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FlaxiaPreviewBot/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return c.json({
        title: targetUrl.hostname,
        description: '',
        image: '',
        siteName: targetUrl.hostname,
        url: targetUrl.toString(),
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return c.json({
        title: targetUrl.pathname.split('/').pop() || targetUrl.hostname,
        description: '',
        image: contentType.startsWith('image/') ? targetUrl.toString() : '',
        siteName: targetUrl.hostname,
        url: targetUrl.toString(),
      });
    }

    const reader = response.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let bytesRead = 0;
      const maxBytes = 256 * 1024; // 256KB

      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesRead += value.length;
          html += decoder.decode(value, { stream: true });
        }
      }
      html += decoder.decode();
    } else {
      html = await response.text();
    }

    const previewData = parseMetaTags(html, targetUrl.toString());
    return c.json(previewData);
  } catch (error: unknown) {
    console.error('Link preview error:', error);
    return c.json({ error: 'Failed to fetch link preview' }, 500);
  }
});

// GET /api/me - check auth state
app.get('/api/me', requireAuth, async (c) => {
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

// GET /api/games - get games (posts with SWF or ZIP payloads) for the arcade
app.get('/api/games', async (c) => {
  try {
    const shuffle = c.req.query('shuffle') === 'true';
    const trending = c.req.query('trending') === 'true';
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const cursor = c.req.query('cursor');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Generate cache key based on query parameters
    const cacheKey = `games:${shuffle ? 'shuffle' : trending ? 'trending' : 'recent'}:${limit}:${cursor || 'first'}`;

    // Try cache only for non-shuffle requests
    if (!shuffle) {
      let cachedData: string | null | undefined;
      try {
        cachedData = await c.env.CACHE?.get(cacheKey);
      } catch {
        // proceed without cache on KV failure
      }
      if (cachedData && !cursor) {
        const parsed = JSON.parse(cachedData);

        const token = getSessionToken(c.req.raw);
        const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
        const currentUserId = sessionData?.user?.id;

        if (currentUserId && parsed.games.length > 0) {
          const gameIds = parsed.games.map((g: Record<string, unknown>) => g.id as string);
          const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, gameIds);

          parsed.games.forEach((game: Record<string, unknown>) => {
            game.isFreshed = freshed.has(game.id as string);
            game.isBookmarked = bookmarked.has(game.id as string);
          });
        }

        return c.json(parsed);
      }
    }

    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    const currentUserId = sessionData?.user?.id;

    if (shuffle) {
      const shuffleToken = c.req.query('token');
      const offset = Math.max(0, Number(c.req.query('offset') || '0'));
      const initialId = c.req.query('initialId');

      let shuffledIds: string[] = [];
      let currentToken = shuffleToken;

      if (currentToken) {
        try {
          const cached = await c.env.CACHE?.get(`games:shuffle:${currentToken}`);
          if (cached) {
            shuffledIds = JSON.parse(cached);
          } else {
            currentToken = undefined;
          }
        } catch {
          currentToken = undefined;
        }
      }

      if (!currentToken) {
        const idResults = await c.env.DB.prepare(`
          SELECT p.id FROM posts p
          WHERE p.payload_key IS NOT NULL AND p.swf_key IS NULL
            AND p.status = 'published'
            AND p.hidden = 0
            AND p.parent_id IS NULL
          ORDER BY p.created_at DESC
        `).all();

        shuffledIds = (idResults.results || []).map((r: Record<string, unknown>) => r.id as string);

        for (let i = shuffledIds.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledIds[i], shuffledIds[j]] = [shuffledIds[j], shuffledIds[i]];
        }

        // If initialId is provided, move it to the front
        if (initialId) {
          const idx = shuffledIds.indexOf(initialId);
          if (idx !== -1) {
            shuffledIds.splice(idx, 1);
            shuffledIds.unshift(initialId);
          } else {
            // Check if the initialId exists and is actually a game post
            const check = await c.env.DB.prepare(`
              SELECT id FROM posts 
              WHERE id = ? AND payload_key IS NOT NULL AND swf_key IS NULL
                AND status = 'published' AND hidden = 0
            `)
              .bind(initialId)
              .first();
            if (check) {
              shuffledIds.unshift(initialId);
            }
          }
        }

        currentToken = crypto.randomUUID();

        try {
          await c.env.CACHE?.put(`games:shuffle:${currentToken}`, JSON.stringify(shuffledIds), {
            expirationTtl: 300,
          });
        } catch (cacheError) {
          console.warn('Failed to cache shuffle order:', cacheError);
        }
      }

      const pageIds = shuffledIds.slice(offset, offset + limit);
      const newOffset = offset + pageIds.length;
      const hasMore = newOffset < shuffledIds.length;

      let shuffledGames: Array<Record<string, unknown>> = [];

      if (pageIds.length > 0) {
        const placeholders = pageIds.map(() => '?').join(',');
        const { results: sliceData } = await c.env.DB.prepare(`
          SELECT
            p.id as postId, p.user_id, p.text, p.swf_key, p.payload_key,
            p.thumbnail_key, p.fresh_count,
            COALESCE(p.reply_count, 0) as reply_count,
            COALESCE(p.bookmark_count, 0) as bookmark_count,
            p.impressions, p.created_at,
            u.username, u.display_name, u.avatar_key
          FROM posts p
          JOIN users u ON p.user_id = u.id
          WHERE p.id IN (${placeholders})
        `)
          .bind(...pageIds)
          .all<{
            postId: string;
            user_id: string;
            text: string;
            swf_key: string | null;
            payload_key: string | null;
            thumbnail_key: string | null;
            fresh_count: number;
            reply_count: number;
            bookmark_count: number;
            impressions: number;
            created_at: string;
            username: string;
            display_name: string | null;
            avatar_key: string | null;
          }>();

        const gameMap = new Map((sliceData || []).map((r) => [r.postId, r]));

        let sliceFreshedPostIds: Set<string> = new Set();
        let sliceBookmarkedPostIds: Set<string> = new Set();
        if (currentUserId && sliceData && sliceData.length > 0) {
          const slicePostIds = sliceData.map((r) => r.postId);
          const result = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, slicePostIds);
          sliceFreshedPostIds = result.freshed;
          sliceBookmarkedPostIds = result.bookmarked;
        }

        shuffledGames = pageIds
          .map((id) => {
            const row = gameMap.get(id);
            if (!row) return null;
            const type = 'zip';
            const game: Record<string, unknown> = {
              id: row.postId,
              postId: row.postId,
              title: row.text?.substring(0, 100) || `Game by @${row.username}`,
              username: row.username,
              displayName: row.display_name || undefined,
              avatarKey: row.avatar_key || undefined,
              type,
              swfKey: row.swf_key || undefined,
              payloadKey: row.payload_key || undefined,
              thumbnailKey: row.thumbnail_key || undefined,
              freshCount: row.fresh_count,
              replyCount: row.reply_count,
              bookmarkCount: row.bookmark_count,
              impressions: row.impressions,
              isFreshed: sliceFreshedPostIds.has(row.postId),
              isBookmarked: sliceBookmarkedPostIds.has(row.postId),
              createdAt: row.created_at,
            };
            return game;
          })
          .filter((x): x is Record<string, unknown> => x !== null);
      }

      return c.json({
        games: shuffledGames,
        hasMore,
        token: currentToken,
        offset: newOffset,
      });
    }

    // Recommended mode: personalized scoring based on interest vector + dwell time
    const recommended = c.req.query('recommended') === 'true';
    if (recommended && currentUserId) {
      const initialId = c.req.query('initialId');

      // Load materialized interest vector (Fresh history + significant dwell plays)
      const profile = await loadOrComputeInterestVector(c.env.DB, currentUserId);
      const interestVector = profile?.vector ?? null;

      // Get dwell stats for all games (shared across users, cached in KV)
      const { dwellStats, maxAvgDwell } = await loadDwellStats(c.env.DB, c.env.CACHE);

      // Get games the user has already played
      const playedSet = new Set<string>();
      const playedResult = await c.env.DB.prepare(`SELECT DISTINCT post_id FROM user_game_plays WHERE user_id = ?`)
        .bind(currentUserId)
        .all<{ post_id: string }>();
      for (const row of playedResult.results || []) {
        playedSet.add(row.post_id);
      }

      // Query candidate game posts
      const candidateQuery = `
        SELECT p.id as postId, p.user_id, p.text, p.swf_key, p.payload_key,
               p.thumbnail_key, p.fresh_count, COALESCE(p.reply_count, 0) as reply_count,
               COALESCE(p.bookmark_count, 0) as bookmark_count,
               p.impressions, p.created_at,
               u.username, u.display_name, u.avatar_key
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.payload_key IS NOT NULL AND p.swf_key IS NULL
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL
        ORDER BY p.created_at DESC
        LIMIT 200
      `;
      const candidates = await c.env.DB.prepare(candidateQuery).all<{
        postId: string;
        user_id: string;
        text: string;
        swf_key: string | null;
        payload_key: string | null;
        thumbnail_key: string | null;
        fresh_count: number;
        reply_count: number;
        bookmark_count: number;
        impressions: number;
        created_at: string;
        username: string;
        display_name: string | null;
        avatar_key: string | null;
      }>();
      const candidateRows = candidates.results || [];

      // Get embeddings for candidates (plus precomputed bandit projections)
      const candEmbeds = new Map<string, { vec: number[]; banditVec: number[] | null; banditCfg: string | null }>();
      if (candidateRows.length > 0) {
        const cIds = candidateRows.map((r) => r.postId);
        const eRows = await c.env.DB.prepare(
          `SELECT post_id, embedding, bandit_vec, bandit_cfg FROM post_embeddings WHERE post_id IN (${cIds.map(() => '?').join(',')})`,
        )
          .bind(...cIds)
          .all<{ post_id: string; embedding: string; bandit_vec: string | null; bandit_cfg: string | null }>();
        for (const row of eRows.results || []) {
          try {
            const v = JSON.parse(row.embedding);
            if (!Array.isArray(v)) continue;
            let banditVec: number[] | null = null;
            if (row.bandit_vec) {
              try {
                const bv = JSON.parse(row.bandit_vec);
                if (Array.isArray(bv)) banditVec = bv;
              } catch {
                /* ignore malformed projection */
              }
            }
            candEmbeds.set(row.post_id, { vec: v, banditVec, banditCfg: row.bandit_cfg ?? null });
          } catch {
            /* skip */
          }
        }
      }

      // Score candidates
      const now = Date.now();
      const dayMs = 86400000;

      // Users without a materialized interest profile (no freshs / long dwells)
      // fall back to a popularity signal so the feed doesn't degenerate to
      // plain recency. Normalized across the candidate set.
      const hasProfile = !!(profile && profile.sourceCount > 0);
      const popularityById = new Map<string, number>();
      if (!hasProfile) {
        let popMin = Number.POSITIVE_INFINITY;
        let popMax = Number.NEGATIVE_INFINITY;
        const popRaw = candidateRows.map((row) => {
          const pop =
            0.5 * Math.log1p(row.fresh_count || 0) +
            0.3 * Math.log1p(row.reply_count || 0) +
            0.2 * Math.log1p(row.bookmark_count || 0) +
            0.4 * Math.log1p(row.impressions || 0);
          if (pop < popMin) popMin = pop;
          if (pop > popMax) popMax = pop;
          return pop;
        });
        candidateRows.forEach((row, i) => {
          const pop = popRaw[i];
          popularityById.set(row.postId, popMax > popMin ? (pop - popMin) / (popMax - popMin) : 0);
        });
      }

      // Contextual bandit (LinUCB) layer, gated by KV config (default off).
      const banditConfig = await loadBanditConfig(c.env.CACHE);
      const banditProj = banditConfig.enabled ? getProjection(banditConfig) : null;
      const banditCfgKey = banditProj ? projConfigKey(banditConfig) : null;
      const banditState = banditConfig.enabled
        ? await loadBanditState(c.env.DB, currentUserId, banditConfig, c.env.CACHE)
        : null;

      const scored = candidateRows.map((row) => {
        const cand = candEmbeds.get(row.postId);
        const emb = cand?.vec;
        let vecSim = 0;
        if (interestVector && emb) {
          vecSim = cosineSimilarity(interestVector, emb);
        }

        const dwellInfo = dwellStats.get(row.postId);
        const expectedDwellNorm = dwellInfo ? dwellInfo.avgDwell / maxAvgDwell : 0;

        const hasPlayed = playedSet.has(row.postId);
        const explorationBonus = hasPlayed ? 0 : 0.2;

        const age = now - new Date(row.created_at).getTime();
        const freshnessBonus = age < dayMs ? 0.1 : 0;

        // Personalization: interest-vector similarity when a profile exists,
        // otherwise the normalized popularity fallback.
        const personalization = hasProfile ? vecSim : popularityById.get(row.postId) || 0;

        const score = 0.35 * personalization + 0.35 * expectedDwellNorm + 0.2 * explorationBonus + 0.1 * freshnessBonus;

        let banditScore = Number.NaN;
        if (banditState && banditProj && cand && emb) {
          // Use the precomputed projection when its config matches the current
          // one; otherwise fall back to projecting on the fly.
          const x = cand.banditVec && cand.banditCfg === banditCfgKey ? cand.banditVec : banditProject(emb, banditProj);
          banditScore = banditComputeScore(banditState, x, banditConfig.alpha);
        }

        return { row, score, banditScore };
      });

      // Normalize bandit scores across candidates and blend with the heuristic.
      if (banditConfig.enabled) {
        const finiteBandit = scored.map((s) => s.banditScore).filter((v) => Number.isFinite(v));
        if (finiteBandit.length > 0) {
          let bMin = Number.POSITIVE_INFINITY;
          let bMax = Number.NEGATIVE_INFINITY;
          for (const v of finiteBandit) {
            if (v < bMin) bMin = v;
            if (v > bMax) bMax = v;
          }
          for (const item of scored) {
            if (!Number.isFinite(item.banditScore)) continue;
            const norm = bMax > bMin ? (item.banditScore - bMin) / (bMax - bMin) : 0.5;
            item.score = banditConfig.lambda * item.score + (1 - banditConfig.lambda) * norm;
          }
        }
      }

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);

      // If initialGameId, promote it to front
      if (initialId) {
        const idx = scored.findIndex((s) => s.row.postId === initialId);
        if (idx !== -1) {
          const item = scored.splice(idx, 1)[0];
          scored.unshift(item);
        }
      }

      // Paginate
      const offset = Math.max(0, Number(c.req.query('offset') || '0'));
      const page = scored.slice(offset, offset + limit);
      const hasMore = offset + limit < scored.length;

      // Check fresh / bookmark status
      let freshedPostIds: Set<string> = new Set();
      let bookmarkedPostIds: Set<string> = new Set();
      if (page.length > 0) {
        const pageIds = page.map((s) => s.row.postId);
        const result = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, pageIds);
        freshedPostIds = result.freshed;
        bookmarkedPostIds = result.bookmarked;
      }

      const games = page.map(({ row }) => {
        const type = 'zip';
        return {
          id: row.postId,
          postId: row.postId,
          title: row.text?.substring(0, 100) || `Game by @${row.username}`,
          username: row.username,
          displayName: row.display_name || undefined,
          avatarKey: row.avatar_key || undefined,
          type,
          swfKey: row.swf_key || undefined,
          payloadKey: row.payload_key || undefined,
          thumbnailKey: row.thumbnail_key || undefined,
          freshCount: row.fresh_count,
          replyCount: row.reply_count,
          bookmarkCount: row.bookmark_count,
          impressions: row.impressions,
          isFreshed: freshedPostIds.has(row.postId),
          isBookmarked: bookmarkedPostIds.has(row.postId),
          createdAt: row.created_at,
        };
      });

      return c.json({ games, hasMore, offset: offset + limit });
    }

    let sql = `
      SELECT
        p.id as postId,
        p.user_id,
        p.text,
        p.swf_key,
        p.payload_key,
        p.thumbnail_key,
        p.fresh_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.bookmark_count, 0) as bookmark_count,
        p.impressions,
        p.created_at,
        u.username,
        u.display_name,
        u.avatar_key
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.payload_key IS NOT NULL AND p.swf_key IS NULL
        AND p.status = 'published'
        AND p.hidden = 0
        AND p.parent_id IS NULL
    `;

    const params: (string | number)[] = [];

    if (cursor) {
      sql += ' AND p.created_at < ?';
      params.push(cursor);
    }

    if (trending) {
      sql += ' ORDER BY (p.fresh_count + p.impressions) DESC, p.created_at DESC';
    } else {
      sql += ' ORDER BY p.created_at DESC';
    }

    sql += ' LIMIT ?';
    params.push(limit + 1);

    const { results } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<{
        postId: string;
        user_id: string;
        text: string;
        swf_key: string | null;
        payload_key: string | null;
        thumbnail_key: string | null;
        fresh_count: number;
        reply_count: number;
        bookmark_count: number;
        impressions: number;
        created_at: string;
        username: string;
        display_name: string | null;
        avatar_key: string | null;
      }>();

    let freshedPostIds: Set<string> = new Set();
    let bookmarkedPostIds: Set<string> = new Set();
    if (currentUserId && results.length > 0) {
      const postIds = results.map((row) => row.postId);
      const result = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
      freshedPostIds = result.freshed;
      bookmarkedPostIds = result.bookmarked;
    }

    const games = (results || []).map((row) => {
      const type = 'zip';
      return {
        id: row.postId,
        postId: row.postId,
        title: row.text?.substring(0, 100) || `Game by @${row.username}`,
        username: row.username,
        displayName: row.display_name || undefined,
        avatarKey: row.avatar_key || undefined,
        type,
        swfKey: row.swf_key || undefined,
        payloadKey: row.payload_key || undefined,
        thumbnailKey: row.thumbnail_key || undefined,
        freshCount: row.fresh_count,
        replyCount: row.reply_count,
        bookmarkCount: row.bookmark_count,
        impressions: row.impressions,
        isFreshed: freshedPostIds.has(row.postId),
        isBookmarked: bookmarkedPostIds.has(row.postId),
        createdAt: row.created_at,
      };
    });

    const hasMore = games.length > limit;
    const trimmedGames = hasMore ? games.slice(0, limit) : games;
    const nextCursor = hasMore ? trimmedGames[trimmedGames.length - 1]?.createdAt : null;

    const responseData = {
      games: trimmedGames,
      hasMore,
      cursor: nextCursor,
    };

    if (!cursor && c.env.CACHE) {
      try {
        const cacheData = {
          games: trimmedGames.map((game) => ({
            ...game,
            isFreshed: false,
            isBookmarked: false,
          })),
          hasMore,
          cursor: nextCursor,
        };
        await c.env.CACHE.put(cacheKey, JSON.stringify(cacheData), {
          expirationTtl: 300,
        });
      } catch (cacheError) {
        console.warn('Failed to cache games data:', cacheError);
      }
    }

    return c.json(responseData);
  } catch (error: unknown) {
    console.error('Games fetch error:', error);
    return c.json({ error: 'Failed to fetch games', details: (error as { message?: string })?.message }, 500);
  }
});

// POST /api/games/events - record raw Arcade interaction events (views incl. skips,
// fresh, reply, fullscreen, share). Superset of /api/games/dwell: positive-dwell
// views are also mirrored into user_game_plays so the existing dwell-based
// recommendation keeps working.
const ARCADE_EVENT_TYPES = new Set(['view', 'fresh', 'reply', 'fullscreen', 'share']);
const MAX_ARCADE_EVENTS_PER_REQUEST = 200;
const BATCH_CHUNK_SIZE = 100;

async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK_SIZE));
  }
}

app.post('/api/games/events', async (c) => {
  try {
    const currentUserId = c.get('user')?.id;
    if (!currentUserId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { sessionId, events } = await c.req.json<{
      sessionId: string;
      events: Array<{
        postId: string;
        eventType: string;
        dwellMs: number;
        swipeVelocity: number;
        didSkip: number;
        isFullscreen: number;
        position: number;
        gameType: string;
      }>;
    }>();

    if (!events || events.length === 0) {
      return c.json({ error: 'No events' }, 400);
    }
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      return c.json({ error: 'Invalid sessionId' }, 400);
    }

    const eventStmt = c.env.DB.prepare(
      `INSERT INTO arcade_events
         (id, user_id, post_id, session_id, position, event_type, dwell_ms,
          swipe_velocity, did_skip, is_fullscreen, game_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const dwellStmt = c.env.DB.prepare(
      `INSERT INTO user_game_plays (id, user_id, post_id, dwell_ms, is_fullscreen, game_type, source)
       VALUES (?, ?, ?, ?, ?, ?, 'arcade')`,
    );

    const banditEvents: Array<{ postId: string; eventType: string; dwellMs: number }> = [];
    const statements: D1PreparedStatement[] = [];
    const eventList = events.slice(0, MAX_ARCADE_EVENTS_PER_REQUEST);

    for (const event of eventList) {
      if (typeof event?.postId !== 'string' || event.postId.length === 0) continue;
      if (typeof event?.eventType !== 'string' || !ARCADE_EVENT_TYPES.has(event.eventType)) continue;

      const dwellMs = Math.max(0, Math.min(Math.round(Number(event.dwellMs) || 0), 86400000));
      const position = Math.max(0, Math.min(Math.round(Number(event.position) || 0), 100000));
      const swipeVelocity = Math.max(0, Math.min(Number(event.swipeVelocity) || 0, 1000));
      const didSkip = event.didSkip ? 1 : 0;
      const isFullscreen = event.isFullscreen ? 1 : 0;
      const gameType = typeof event.gameType === 'string' ? event.gameType.slice(0, 32) : '';

      statements.push(
        eventStmt.bind(
          crypto.randomUUID(),
          currentUserId,
          event.postId,
          sessionId,
          position,
          event.eventType,
          dwellMs,
          swipeVelocity,
          didSkip,
          isFullscreen,
          gameType,
        ),
      );

      // Mirror positive-dwell views into the existing dwell aggregate table.
      if (event.eventType === 'view' && dwellMs > 2000) {
        statements.push(
          dwellStmt.bind(crypto.randomUUID(), currentUserId, event.postId, dwellMs, isFullscreen, gameType),
        );
      }

      banditEvents.push({ postId: event.postId, eventType: event.eventType, dwellMs });
    }

    await runBatched(c.env.DB, statements);

    // Feed the dwell-maximizing bandit with rewards (no-op while disabled).
    await applyBanditRewards(c.env.DB, c.env.CACHE, currentUserId, banditEvents);

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Arcade events record error:', error);
    return c.json({ error: 'Failed to record events' }, 500);
  }
});

// POST /api/games/dwell - record game play dwell time
app.post('/api/games/dwell', async (c) => {
  try {
    const currentUserId = c.get('user')?.id;
    if (!currentUserId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { plays } = await c.req.json<{
      plays: Array<{ postId: string; dwellMs: number; isFullscreen: number; gameType: string }>;
    }>();
    if (!plays || plays.length === 0) {
      return c.json({ error: 'No plays' }, 400);
    }

    const stmt = c.env.DB.prepare(
      `INSERT INTO user_game_plays (id, user_id, post_id, dwell_ms, is_fullscreen, game_type, source)
       VALUES (?, ?, ?, ?, ?, ?, 'arcade')`,
    );

    const statements: D1PreparedStatement[] = [];
    for (const play of plays.slice(0, MAX_ARCADE_EVENTS_PER_REQUEST)) {
      const id = crypto.randomUUID();
      statements.push(stmt.bind(id, currentUserId, play.postId, play.dwellMs, play.isFullscreen, play.gameType));
    }
    await runBatched(c.env.DB, statements);

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Dwell record error:', error);
    return c.json({ error: 'Failed to record dwell' }, 500);
  }
});

// Auth routes (extracted to routes/auth.ts)
app.route('/api/auth', authRouter);

// Media routes (extracted to routes/media.ts)
app.route('/api', mediaRouter);

// User routes (extracted to routes/users.ts)
app.route('/api', usersRouter);

// Poll routes (extracted to routes/polls.ts)
app.route('/api', pollsRouter);

// GET /api/posts - timeline
app.get('/api/posts', async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const hashtag = c.req.query('hashtag');
    const following = c.req.query('following') === 'true';
    const username = c.req.query('username');

    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available');
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get current user ID for fresh status (optional for all tabs, required for Following tab)
    let currentUserId: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    if (sessionData) {
      currentUserId = sessionData.user.id;
    }

    // For Following tab, require authentication
    if (following && !currentUserId) {
      return c.json({ error: 'Authentication required for Following tab' }, 401);
    }

    // Try cache hit (first page only)
    if (!cursor) {
      const cacheKey = makeCacheKey(
        'timeline',
        c,
        `${limit}:${hashtag || ''}:${following ? 'following' : ''}:${username || ''}`,
        !following,
      );
      const cached = await kvCacheGet<{ posts: Record<string, unknown>[] }>(c, cacheKey);
      if (cached) {
        // User-agnostic cache: shared feeds must re-apply the current user's block list.
        let posts = cached.posts;
        if (!following && !username) {
          posts = (await filterBlockedAuthors(c.env.DB, currentUserId, posts)).slice(0, limit);
        }
        if (currentUserId && posts.length > 0) {
          const postIds = posts.map((p) => String(p.id));
          const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
          posts.forEach((post: Record<string, unknown>) => {
            post.is_freshed = freshed.has(post.id as string);
            post.is_bookmarked = bookmarked.has(post.id as string);
          });
        }
        await enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId);
        await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
        await enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId);
        return c.json({ posts });
      }
    }

    let query: string;
    let params: Array<string | number> = [];

    // Helper: exclude posts from users blocked by current user
    const blockFilter = currentUserId
      ? 'AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)'
      : '';
    const blockParam = currentUserId ? [currentUserId] : [];
    // Shared first pages fetch a small surplus so the user-agnostic cache can
    // still return a full page after the per-user block filter runs in JS.
    const fetchLimit = limit + 20;

    if (hashtag) {
      // Filter by hashtag using json_each
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) AND p.created_at < ? ${blockFilter} ORDER BY p.created_at DESC LIMIT ?`;
        params = [hashtag, cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) ORDER BY p.created_at DESC LIMIT ?`;
        params = [hashtag, fetchLimit];
      }
    } else if (following && currentUserId) {
      // Following tab - show posts from followed users and current user's own posts
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
          COALESCE(p.reply_count, 0) as reply_count, 
          COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
          FROM posts p 
          LEFT JOIN users u ON p.user_id = u.id 
          WHERE (
            p.user_id IN (
              SELECT followee_id FROM follows WHERE follower_id = ?
            )
            OR p.user_id = ?
          )
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? ${blockFilter}
          ORDER BY p.created_at DESC LIMIT ?`;
        params = [currentUserId, currentUserId, cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
          COALESCE(p.reply_count, 0) as reply_count, 
          COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
          FROM posts p 
          LEFT JOIN users u ON p.user_id = u.id 
          WHERE (
            p.user_id IN (
              SELECT followee_id FROM follows WHERE follower_id = ?
            )
            OR p.user_id = ?
          )
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${blockFilter}
          ORDER BY p.created_at DESC LIMIT ?`;
        params = [currentUserId, currentUserId, ...blockParam, limit];
      }
    } else if (username) {
      // Username filter - show posts from specific user
      if (cursor) {
        query =
          "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.username = ? AND p.hidden = 0 AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?";
        params = [username, cursor, limit];
      } else {
        query =
          "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.username = ? AND p.hidden = 0 ORDER BY p.created_at DESC LIMIT ?";
        params = [username, limit];
      }
    } else {
      // Regular timeline query (For You tab)
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? ${blockFilter} ORDER BY p.created_at DESC LIMIT ?`;
        params = [cursor, ...blockParam, limit];
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count,           COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ORDER BY p.created_at DESC LIMIT ?`;
        params = [fetchLimit];
      }
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!result.success) {
      console.error('Database query failed:', result);
      return c.json({ error: 'Failed to fetch posts' }, 500);
    }

    const rawPosts = result.results || [];

    // Shared first pages (For You / hashtag) fetch without the SQL block filter
    // so the cache can be shared across users; apply the block list in JS here
    // and trim back to the requested page size.
    const posts =
      !cursor && !following && !username
        ? (await filterBlockedAuthors(c.env.DB, currentUserId, rawPosts)).slice(0, limit)
        : rawPosts;

    // Parallel: fresh/bookmark status, poll enrichment, vector embedding check
    await Promise.all([
      // Fresh and bookmark status for current user
      (async () => {
        if (!currentUserId || posts.length === 0) return;
        const postIds = posts.map((p: Record<string, unknown>) => String(p.id));
        const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
        posts.forEach((post: Record<string, unknown>) => {
          post.is_freshed = freshed.has(post.id as string);
          post.is_bookmarked = bookmarked.has(post.id as string);
        });
      })(),
      // Poll enrichment
      enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId),
      // Quote enrichment
      enrichPostsWithQuotes(posts as PostRow[], c.env.DB),
      // Reaction enrichment
      enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId),
      // Vector embedding check for unprocessed posts
      (async () => {
        const textPosts = (posts as PostRow[]).filter((p) => p.text);
        if (textPosts.length === 0) return;
        const textPostIds = textPosts.map((p) => p.id);
        const textPlaceholders = textPostIds.map(() => '?').join(',');
        const embeddedResult = await c.env.DB.prepare(
          `SELECT post_id FROM post_embeddings WHERE post_id IN (${textPlaceholders})`,
        )
          .bind(...textPostIds)
          .all<{ post_id: string }>();
        const embeddedIds = new Set((embeddedResult.success ? embeddedResult.results : []).map((r) => r.post_id));
        for (const p of textPosts) {
          if (!embeddedIds.has(p.id)) {
            embedPost(c.env.DB, c.env.CROWD_ORCHESTRATOR_URL, c.env.CROWD_API_KEY, c.env.BASE_URL, p.id, p.text).catch(
              (e) => console.error('Background embed failed:', e),
            );
          }
        }
      })(),
    ]);

    // Write to KV cache (first page only). Shared feeds cache the raw
    // (unblocked) post list so any user's block list can be applied on read.
    if (!cursor && c.env.CACHE) {
      const cacheKey = makeCacheKey(
        'timeline',
        c,
        `${limit}:${hashtag || ''}:${following ? 'following' : ''}:${username || ''}`,
        !following,
      );
      const cacheData = {
        posts: (rawPosts as Record<string, unknown>[]).map((p) => ({ ...p, is_freshed: false, is_bookmarked: false })),
      };
      await kvCacheSet(c, cacheKey, cacheData, 15);
    }

    // Return total count when filtering by hashtag
    if (hashtag) {
      const countResult = await c.env.DB.prepare(`
        SELECT COUNT(*) as count FROM posts WHERE status = 'published' AND hidden = 0 AND parent_id IS NULL AND id IN (SELECT posts.id FROM posts, json_each(posts.hashtags) WHERE value = ?)
      `)
        .bind(hashtag)
        .first<{ count: number }>();
      return c.json({ posts, count: countResult?.count || 0 });
    }

    return c.json({ posts });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Posts fetch error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/posts/trending - get trending posts based on engagement and time decay
app.get('/api/posts/trending', async (c) => {
  try {
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const cursor = c.req.query('cursor');
    const parts = cursor ? cursor.split(',') : [];
    const cursorScore = parts[0] || null;
    const cursorCreatedAt = parts[1] || null;
    const cursorId = parts[2] || null;
    let numericScore = cursorScore !== null ? parseFloat(cursorScore) : null;
    if (Number.isNaN(numericScore!)) numericScore = null;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get current user for fresh status
    let currentUserId: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    if (sessionData) {
      currentUserId = sessionData.user.id;
    }

    // Try cache hit (only for non-cursor requests)
    if (!cursor) {
      const cacheKey = makeCacheKey('trending', c, `${limit}`, false);
      const cached = await kvCacheGet<{ posts: Record<string, unknown>[] }>(c, cacheKey);
      if (cached) {
        // User-agnostic cache: re-apply the current user's block list.
        const posts = await filterBlockedAuthors(c.env.DB, currentUserId, cached.posts);
        if (currentUserId && posts.length > 0) {
          const postIds = posts.map((p) => String(p.id));
          const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
          posts.forEach((post) => {
            post.is_freshed = freshed.has(post.id as string);
            post.is_bookmarked = bookmarked.has(post.id as string);
          });
        }
        await enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId);
        await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
        await enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId);
        return c.json({ posts });
      }
    }

    // Trending algorithm:
    //   base_score = (fresh*2 + reply*3 + impression*0.1 + 1) / (hours+2)^1.5
    //   adjusted by content type weights and quality score
    const trendingFetchLimit = limit * 5;
    const query = `
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
      COALESCE(p.reply_count, 0) as reply_count,
      COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
      ((p.fresh_count * 2.0 + COALESCE(p.reply_count, 0) * 3.0 + p.impressions * 0.1 + 1.0) /
      EXP(1.5 * LN((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0))) as score
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at > datetime('now', '-7 days')
      ORDER BY score DESC, p.created_at DESC
      LIMIT ?
    `;
    const params: Array<unknown> = [trendingFetchLimit];

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();
    const rawPosts = (result.results || []) as Record<string, unknown>[];

    // Compute author quality scores per user
    const authorQualityMap = new Map<string, number>();
    const userIds = [...new Set(rawPosts.map((p) => p.user_id as string))].filter(Boolean);
    if (userIds.length > 0) {
      const authorRows = await c.env.DB.prepare(
        `SELECT u.id, u.display_name, u.bio, u.avatar_key, u.created_at,
          COALESCE(SUM(p.fresh_count), 0) as total_fresh,
          COALESCE(SUM(p.reply_count), 0) as total_reply,
          COALESCE(SUM(p.impressions), 0) as total_impressions,
          COUNT(p.id) as post_count
         FROM users u
         LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'published'
         WHERE u.id IN (${userIds.map(() => '?').join(',')})
         GROUP BY u.id`,
      )
        .bind(...userIds)
        .all<{
          id: string;
          display_name: string | null;
          bio: string | null;
          avatar_key: string | null;
          created_at: string;
          total_fresh: number;
          total_reply: number;
          total_impressions: number;
          post_count: number;
        }>();
      for (const row of authorRows.results || []) {
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        const accountAgeDays = ageMs / 86400000;
        const postCount = row.post_count || 1;
        const authorQuality = computeAuthorQuality({
          freshRatio: (row.total_fresh || 0) / postCount / 5,
          replyRate: (row.total_reply || 0) / Math.max(row.total_impressions || postCount, 1),
          accountAgeDays: Math.max(accountAgeDays, 1),
          hasDisplayName: !!row.display_name,
          hasBio: !!row.bio,
          hasAvatar: !!row.avatar_key,
        });
        // Map from 0-1 range to 0.5-1.5 multiplier range
        authorQualityMap.set(row.id, 0.5 + authorQuality);
      }
    }

    // Compute adjusted score with quality, type weights, and author quality
    const scored = rawPosts.map((p) => {
      const qualityScore = computeQualityScore(String(p.text || ''), !!(p.payload_key || p.swf_key), 0);
      const typeFactor = (() => {
        const w = getTypeWeights(p.payload_key as string | null, p.swf_key as string | null);
        return (w.fresh + w.reply + w.impression) / 4.5;
      })();
      const authorQuality = authorQualityMap.get(p.user_id as string) || 1.0;
      const rawScore = Number(p.score) || 0;
      const fresh = freshnessBoost(p.created_at as string);
      return { post: p, score: rawScore * qualityScore * typeFactor * authorQuality * fresh };
    });

    // Cursor filtering and sorting
    let filtered = scored;
    if (numericScore !== null && cursorCreatedAt) {
      filtered = scored.filter((s) => {
        const ca = String(s.post.created_at || '');
        const id = String(s.post.id || '');
        return (
          s.score < numericScore! ||
          (s.score === numericScore && ca < cursorCreatedAt!) ||
          (s.score === numericScore && ca === cursorCreatedAt && id < cursorId!)
        );
      });
    }

    filtered.sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      const ca = String(b.post.created_at || '').localeCompare(String(a.post.created_at || ''));
      if (ca !== 0) return ca;
      return String(b.post.id || '').localeCompare(String(a.post.id || ''));
    });

    const page = filtered.slice(0, limit);

    // Build enriched posts (unfiltered, so the shared cache stays block-free)
    const posts = page.map((s) => {
      const p = s.post;
      p.score = s.score;
      return p;
    });

    // Re-apply the current user's block list for the response only.
    const visiblePosts = await filterBlockedAuthors(c.env.DB, currentUserId, posts);

    // Add fresh and bookmark status for current user if logged in
    if (currentUserId && visiblePosts.length > 0) {
      const postIds = visiblePosts.map((p: Record<string, unknown>) => String(p.id));
      const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
      visiblePosts.forEach((post: Record<string, unknown>) => {
        post.is_freshed = freshed.has(post.id as string);
        post.is_bookmarked = bookmarked.has(post.id as string);
      });
    }

    await enrichPostsWithPolls(visiblePosts as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(visiblePosts as PostRow[], c.env.DB);
    await enrichPostsWithReactions(visiblePosts as PostRow[], c.env.DB, currentUserId);

    // Write to cache (non-cursor only)
    if (!cursor && c.env.CACHE) {
      const cacheKey = makeCacheKey('trending', c, `${limit}`, false);
      const cacheData = {
        posts: posts.map((p: Record<string, unknown>) => ({ ...p, is_freshed: false, is_bookmarked: false })),
        next_cursor:
          posts.length > 0
            ? `${(posts[posts.length - 1] as Record<string, unknown>).score},${(posts[posts.length - 1] as Record<string, unknown>).created_at},${(posts[posts.length - 1] as Record<string, unknown>).id}`
            : null,
      };
      await kvCacheSet(c, cacheKey, cacheData, 30);
    }

    const nextCursor =
      visiblePosts.length > 0
        ? `${(visiblePosts[visiblePosts.length - 1] as Record<string, unknown>).score},${(visiblePosts[visiblePosts.length - 1] as Record<string, unknown>).created_at},${(visiblePosts[visiblePosts.length - 1] as Record<string, unknown>).id}`
        : null;

    return c.json({ posts: visiblePosts, next_cursor: nextCursor });
  } catch (error: unknown) {
    console.error('Trending posts error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/tags/trending - get top 5 trending hashtags (based on recent N posts percentage)
app.get('/api/tags/trending', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const recentCountParam = c.req.query('recent_count');
    const recentCount = recentCountParam ? parseInt(recentCountParam, 10) : 100;
    const validRecentCount = Number.isNaN(recentCount) || recentCount < 10 || recentCount > 1000 ? 100 : recentCount;

    const result = await c.env.DB.prepare(`
WITH recent_posts AS (
  SELECT id, hashtags
  FROM posts
  WHERE hidden = 0 AND status = 'published'
  ORDER BY created_at DESC
  LIMIT ?
)
SELECT
  value AS tag,
  COUNT(*) AS count,
  ROUND(COUNT(*) * 100.0 / ?, 1) AS percentage
FROM recent_posts, json_each(recent_posts.hashtags)
GROUP BY value
ORDER BY count DESC
LIMIT 5
    `)
      .bind(validRecentCount, validRecentCount)
      .all();

    if (!result.success) {
      return c.json({ error: 'Failed to fetch trending tags' }, 500);
    }

    const tags = result.results || [];

    return c.json({ tags }, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Trending tags error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/tags/suggest?q=prefix - suggest hashtags matching prefix
app.get('/api/tags/suggest', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q || q.length < 1) {
      return c.json({ tags: [] });
    }

    const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 20);
    const prefix = q.toLowerCase();

    const result = await c.env.DB.prepare(`
      SELECT DISTINCT value AS tag, COUNT(*) AS count
      FROM posts, json_each(posts.hashtags)
      WHERE posts.hidden = 0 AND posts.status = 'published'
        AND LOWER(value) LIKE ?
      GROUP BY value
      ORDER BY count DESC
      LIMIT ?
    `)
      .bind(prefix + '%', limit)
      .all();

    const tags = result.results || [];
    return c.json({ tags }, 200, {
      'Cache-Control': 'public, max-age=30',
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Tag suggest error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const PROFILE_TTL_MS = 5 * 60 * 1000;

// Materialized weighted interest vector persisted in user_profiles so the
// recommender avoids re-deriving it on every request. Returns null when the
// user has no positive signal history yet.
async function loadOrComputeInterestVector(
  db: D1Database,
  userId: string,
): Promise<{ vector: number[]; sourceCount: number } | null> {
  const cached = await db
    .prepare(
      `SELECT interest_vec, source_count, updated_at FROM user_profiles
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{ interest_vec: string; source_count: number; updated_at: string }>();

  if (cached) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < PROFILE_TTL_MS) {
      try {
        const v = JSON.parse(cached.interest_vec);
        if (Array.isArray(v) && v.length > 0) {
          return { vector: v, sourceCount: cached.source_count };
        }
      } catch {
        /* fall through to recompute */
      }
    }
  }

  const dim = 1024;
  const freshRows = await db
    .prepare(
      `SELECT f.post_id FROM freshs f JOIN posts p ON p.id = f.post_id
       WHERE f.user_id = ? ORDER BY p.created_at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<{ post_id: string }>();
  const freshIds = (freshRows.results || []).map((r) => r.post_id);

  const gamePlayRows = await db
    .prepare(
      `SELECT post_id, dwell_ms FROM user_game_plays
       WHERE user_id = ? AND dwell_ms > 5000
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<{ post_id: string; dwell_ms: number }>();
  const gamePlays = gamePlayRows.results || [];

  const allSourceIds = [...freshIds, ...gamePlays.map((r) => r.post_id)];
  const dwellMap = new Map(gamePlays.map((r) => [r.post_id, r.dwell_ms]));

  let vector: number[] | null = null;
  let sourceCount = 0;

  if (allSourceIds.length > 0) {
    const embedRows = await db
      .prepare(
        `SELECT post_id, embedding FROM post_embeddings WHERE post_id IN (${allSourceIds.map(() => '?').join(',')})`,
      )
      .bind(...allSourceIds)
      .all<{ post_id: string; embedding: string }>();
    const weightedEmbeds: Array<{ vec: number[]; weight: number }> = [];
    for (const row of embedRows.results || []) {
      try {
        const v = JSON.parse(row.embedding);
        if (!Array.isArray(v)) continue;
        const dwellW = dwellMap.get(row.post_id);
        // Fresh = weight 1.0, game play with dwell = weight min(dwell_ms / 30000, 1.0)
        const w = dwellW ? Math.min(dwellW / 30000, 1.0) : 1.0;
        weightedEmbeds.push({ vec: v, weight: w });
      } catch {
        /* skip malformed */
      }
    }
    if (weightedEmbeds.length > 0) {
      const totalWeight = weightedEmbeds.reduce((s, e) => s + e.weight, 0);
      vector = new Array(dim).fill(0);
      for (const { vec, weight } of weightedEmbeds) {
        for (let i = 0; i < dim; i++) vector[i] += (vec[i] || 0) * weight;
      }
      for (let i = 0; i < dim; i++) vector[i] /= totalWeight;
      sourceCount = weightedEmbeds.length;
    }
  }

  if (vector) {
    await db
      .prepare(
        `INSERT INTO user_profiles (user_id, interest_vec, source_count, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET interest_vec = excluded.interest_vec,
           source_count = excluded.source_count, updated_at = excluded.updated_at`,
      )
      .bind(userId, JSON.stringify(vector), sourceCount, new Date().toISOString())
      .run();
  }

  return vector ? { vector, sourceCount } : null;
}

const DWELL_STATS_CACHE_KEY = 'arcade:dwell:stats:v2';
const DWELL_STATS_TTL_S = 60;

// Aggregate dwell stats are shared across all users, so cache them globally
// (60s) instead of re-scanning the whole user_game_plays table on every
// recommended-games request. The scan is also bounded to a recent window.
async function loadDwellStats(
  db: D1Database,
  cache: KVNamespace | undefined,
): Promise<{ dwellStats: Map<string, { avgDwell: number; playCount: number }>; maxAvgDwell: number }> {
  if (cache) {
    try {
      const raw = await cache.get(DWELL_STATS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, { avgDwell: number; playCount: number }>;
        const dwellStats = new Map(Object.entries(parsed));
        let maxAvgDwell = 1;
        for (const d of dwellStats.values()) {
          if (d.avgDwell > maxAvgDwell) maxAvgDwell = d.avgDwell;
        }
        return { dwellStats, maxAvgDwell };
      }
    } catch {
      /* fall through to recompute */
    }
  }

  const dwellStats = new Map<string, { avgDwell: number; playCount: number }>();
  const dwellResult = await db
    .prepare(
      `SELECT post_id, AVG(dwell_ms) as avg_dwell, COUNT(*) as play_count
       FROM user_game_plays
       WHERE dwell_ms > 2000 AND created_at > datetime('now', '-30 days')
       GROUP BY post_id`,
    )
    .all<{ post_id: string; avg_dwell: number; play_count: number }>();
  let maxAvgDwell = 1;
  for (const row of dwellResult.results || []) {
    const avgDwell = Number(row.avg_dwell) || 0;
    dwellStats.set(row.post_id, { avgDwell, playCount: row.play_count });
    if (avgDwell > maxAvgDwell) maxAvgDwell = avgDwell;
  }
  if (cache) {
    try {
      await cache.put(DWELL_STATS_CACHE_KEY, JSON.stringify(Object.fromEntries(dwellStats)), {
        expirationTtl: DWELL_STATS_TTL_S,
      });
    } catch {
      /* ignore cache write failure */
    }
  }
  return { dwellStats, maxAvgDwell };
}

const BANDIT_CONFIG_KEY = 'arcade:bandit:config';
const BANDIT_PRIOR_KEY = 'arcade:bandit:prior';
const projectionCache = new Map<string, number[][]>();

function getProjection(config: LinUCBConfig): number[][] {
  const key = `${config.seed}:${config.srcDim}:${config.dim}`;
  let proj = projectionCache.get(key);
  if (!proj) {
    proj = createProjection(config.srcDim, config.dim, config.seed);
    projectionCache.set(key, proj);
  }
  return proj;
}

async function loadBanditConfig(cache: KVNamespace | undefined): Promise<LinUCBConfig> {
  if (!cache) return { ...parseBanditConfig(null) };
  try {
    return parseBanditConfig(await cache.get(BANDIT_CONFIG_KEY));
  } catch {
    return { ...parseBanditConfig(null) };
  }
}

// Learned global policy deployed from the offline training pipeline. Only used
// when its projection config (seed/srcDim/dim) matches the active bandit.
async function loadBanditPrior(cache: KVNamespace | undefined): Promise<BanditPrior | null> {
  if (!cache) return null;
  try {
    return parseBanditPrior(await cache.get(BANDIT_PRIOR_KEY));
  } catch {
    return null;
  }
}

async function loadBanditState(
  db: D1Database,
  userId: string,
  config: LinUCBConfig,
  cache?: KVNamespace | undefined,
): Promise<LinUCBState> {
  const row = await db
    .prepare(`SELECT a_inv, b, t FROM bandit_state WHERE user_id = ?`)
    .bind(userId)
    .first<{ a_inv: string; b: string; t: number }>();
  if (row) {
    try {
      const parsed = JSON.parse(row.a_inv) as number[];
      const b = JSON.parse(row.b) as number[];
      if (
        Array.isArray(parsed) &&
        parsed.length === config.dim * config.dim &&
        Array.isArray(b) &&
        b.length === config.dim
      ) {
        return { aInv: parsed.map(Number), b: b.map(Number), t: row.t || 0 };
      }
    } catch {
      /* fall through to fresh state */
    }
  }
  const prior = await loadBanditPrior(cache);
  if (
    prior &&
    prior.dim === config.dim &&
    prior.seed === config.seed &&
    prior.srcDim === config.srcDim &&
    prior.theta.length === config.dim
  ) {
    return createStateFromPrior(config.dim, prior.theta, prior.lambda0);
  }
  return createState(config.dim);
}

async function saveBanditState(db: D1Database, userId: string, state: LinUCBState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bandit_state (user_id, a_inv, b, t, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET a_inv = excluded.a_inv, b = excluded.b,
         t = excluded.t, updated_at = excluded.updated_at`,
    )
    .bind(userId, serializeState(state), JSON.stringify(state.b), state.t, new Date().toISOString())
    .run();
}

// Apply bandit reward updates for a batch of Arcade events. Loads the game
// embeddings once per batch and performs a single state read + write per user.
async function applyBanditRewards(
  db: D1Database,
  cache: KVNamespace | undefined,
  userId: string,
  events: Array<{ postId: string; eventType: string; dwellMs: number }>,
): Promise<void> {
  const config = await loadBanditConfig(cache);
  if (!config.enabled || events.length === 0) return;

  const proj = getProjection(config);
  const cfgKey = projConfigKey(config);
  const distinctPostIds = Array.from(new Set(events.map((e) => e.postId)));
  if (distinctPostIds.length === 0) return;

  const embedRows = await db
    .prepare(
      `SELECT post_id, embedding, bandit_vec, bandit_cfg FROM post_embeddings WHERE post_id IN (${distinctPostIds.map(() => '?').join(',')})`,
    )
    .bind(...distinctPostIds)
    .all<{ post_id: string; embedding: string; bandit_vec: string | null; bandit_cfg: string | null }>();
  const embeds = new Map<string, { vec: number[]; banditVec: number[] | null; banditCfg: string | null }>();
  for (const row of embedRows.results || []) {
    try {
      const v = JSON.parse(row.embedding);
      if (!Array.isArray(v)) continue;
      let banditVec: number[] | null = null;
      if (row.bandit_vec) {
        try {
          const bv = JSON.parse(row.bandit_vec);
          if (Array.isArray(bv)) banditVec = bv;
        } catch {
          /* ignore malformed projection */
        }
      }
      embeds.set(row.post_id, { vec: v, banditVec, banditCfg: row.bandit_cfg ?? null });
    } catch {
      /* skip */
    }
  }

  const state = await loadBanditState(db, userId, config, cache);
  let dirty = false;
  for (const event of events) {
    const cand = embeds.get(event.postId);
    if (!cand || !cand.vec) continue;
    const x = cand.banditVec && cand.banditCfg === cfgKey ? cand.banditVec : banditProject(cand.vec, proj);
    banditApplyReward(state, x, eventReward(event.eventType, event.dwellMs));
    dirty = true;
  }
  if (dirty) {
    await saveBanditState(db, userId, state);
  }
}

function diversifyPosts(
  items: Array<{ post: Record<string, unknown>; score: number }>,
  maxCount: number,
  maxPerUser: number,
): Array<{ post: Record<string, unknown>; score: number }> {
  const userCounts = new Map<string, number>();
  const result: Array<{ post: Record<string, unknown>; score: number }> = [];
  for (const item of items) {
    if (result.length >= maxCount) break;
    const userId = String(item.post.user_id || '');
    const count = userCounts.get(userId) || 0;
    if (count >= maxPerUser) continue;
    userCounts.set(userId, count + 1);
    result.push(item);
  }
  return result;
}

const RECOMMENDED_SELECT = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
  COALESCE(p.reply_count, 0) as reply_count, 
  COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at`;

// GET /api/posts/recommended - get recommended posts for the user (vector hybrid)
app.get('/api/posts/recommended', async (c) => {
  try {
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const cursor = c.req.query('cursor');
    let cursorScore: string | null = null;
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      const parts = cursor.split(',');
      cursorScore = parts[0] || null;
      cursorCreatedAt = parts[1] || null;
      cursorId = parts[2] || null;
    }
    let numericCursor = cursorScore !== null ? parseFloat(cursorScore) : null;
    if (Number.isNaN(numericCursor!)) numericCursor = null;

    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const currentUserId = c.get('user')?.id;

    // Build user interest vector from Fresh history + game dwell signals.
    // Uses the materialized user_profiles vector (5-min TTL) instead of
    // re-deriving and JSON-parsing up to 100 embeddings on every request.
    let interestVector: number[] | null = null;
    if (currentUserId) {
      const profile = await loadOrComputeInterestVector(c.env.DB, currentUserId);
      interestVector = profile?.vector ?? null;
    }

    // Try hybrid vector-based recommendations if we have an interest vector
    let enrichedPosts: Record<string, unknown>[] = [];
    let nextCursor: string | null = null;

    if (interestVector) {
      let vectorMatches: Array<{ id: string; score: number }> = [];
      const vectorize = c.env.VECTORIZE;

      if (vectorize) {
        try {
          const queryResult = await vectorize.query(interestVector, {
            topK: 100,
            returnValues: false,
            returnMetadata: false,
          });
          vectorMatches = (queryResult.matches || []).map((m) => ({ id: m.id, score: m.score }));
          vectorMatches = vectorMatches.slice(0, 80);
        } catch (e) {
          console.error('Vectorize query failed, falling back to D1:', e);
        }
      }

      // Fallback: compute cosine similarity from D1 post_embeddings
      if (vectorMatches.length === 0) {
        const allEmbedRows = await c.env.DB.prepare(
          'SELECT post_id, embedding FROM post_embeddings ORDER BY created_at DESC LIMIT 300',
        ).all<{
          post_id: string;
          embedding: string;
        }>();
        for (const row of allEmbedRows.results || []) {
          try {
            const v = JSON.parse(row.embedding);
            if (Array.isArray(v)) {
              const sim = cosineSimilarity(interestVector, v);
              vectorMatches.push({ id: row.post_id, score: sim });
            }
          } catch {
            /* skip */
          }
        }
        vectorMatches.sort((a, b) => b.score - a.score);
        vectorMatches = vectorMatches.slice(0, 80);
      }

      if (vectorMatches.length > 0) {
        const candidateIds = vectorMatches.map((m) => m.id);
        const engFormula = `(p.engagement_hotness / EXP(1.5 * LN((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0)))`;
        const candidateQuery = `${RECOMMENDED_SELECT}, ${engFormula} as eng_score FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id IN (${candidateIds.map(() => '?').join(',')}) AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL`;
        const candResult = await c.env.DB.prepare(candidateQuery)
          .bind(...candidateIds)
          .all();
        const candidatePosts = (candResult.results || []) as Array<Record<string, unknown>>;

        if (candidatePosts.length > 0) {
          // Filter out posts from blocked users
          if (currentUserId) {
            const blockedIds = await c.env.DB.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?')
              .bind(currentUserId)
              .all<{ blocked_id: string }>();
            if (blockedIds.success && blockedIds.results.length > 0) {
              const blockedSet = new Set(blockedIds.results.map((r) => r.blocked_id));
              const filteredPosts = candidatePosts.filter((p) => !blockedSet.has(p.user_id as string));
              if (filteredPosts.length < candidatePosts.length) {
                candidatePosts.length = 0;
                candidatePosts.push(...filteredPosts);
              }
            }
          }
          const engScores = candidatePosts.map((p) => Number(p.eng_score) || 0);
          const maxEng = Math.max(...engScores, 1);
          const vecScoreMap = new Map(vectorMatches.map((m) => [m.id, m.score]));
          const maxVec = Math.max(...vectorMatches.map((m) => m.score), 1);

          // Compute author quality scores
          const authorQualityMap = new Map<string, number>();
          const authorIds = [...new Set(candidatePosts.map((p) => p.user_id as string))].filter(Boolean);
          if (authorIds.length > 0) {
            const authorRows = await c.env.DB.prepare(
              `SELECT u.id, u.display_name, u.bio, u.avatar_key, u.created_at,
                COALESCE(SUM(p.fresh_count), 0) as total_fresh,
                COALESCE(SUM(p.reply_count), 0) as total_reply,
                COALESCE(SUM(p.impressions), 0) as total_impressions,
                COUNT(p.id) as post_count
               FROM users u
               LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'published'
               WHERE u.id IN (${authorIds.map(() => '?').join(',')})
               GROUP BY u.id`,
            )
              .bind(...authorIds)
              .all<{
                id: string;
                display_name: string | null;
                bio: string | null;
                avatar_key: string | null;
                created_at: string;
                total_fresh: number;
                total_reply: number;
                total_impressions: number;
                post_count: number;
              }>();
            for (const row of authorRows.results || []) {
              const ageMs = Date.now() - new Date(row.created_at).getTime();
              const accountAgeDays = ageMs / 86400000;
              const postCount = row.post_count || 1;
              const authorQuality = computeAuthorQuality({
                freshRatio: (row.total_fresh || 0) / postCount / 5,
                replyRate: (row.total_reply || 0) / Math.max(row.total_impressions || postCount, 1),
                accountAgeDays: Math.max(accountAgeDays, 1),
                hasDisplayName: !!row.display_name,
                hasBio: !!row.bio,
                hasAvatar: !!row.avatar_key,
              });
              authorQualityMap.set(row.id, 0.5 + authorQuality);
            }
          }

          const hybrid = candidatePosts.map((p) => {
            const vecSim = (vecScoreMap.get(p.id as string) || 0) / maxVec;
            const engNorm = (Number(p.eng_score) || 0) / maxEng;
            const qualityScore = computeQualityScore(String(p.text || ''), !!(p.payload_key || p.swf_key), 0);
            const typeFactor = (() => {
              const w = getTypeWeights(p.payload_key as string | null, p.swf_key as string | null);
              return (w.fresh + w.reply + w.impression) / 4.5;
            })();
            const authorQuality = authorQualityMap.get(p.user_id as string) || 1.0;
            const fresh = freshnessBoost(p.created_at as string);
            return {
              post: p,
              score: (0.7 * vecSim + 0.3 * engNorm) * qualityScore * typeFactor * authorQuality * fresh,
            };
          });

          hybrid.sort((a, b) => {
            const diff = b.score - a.score;
            if (diff !== 0) return diff;
            const ca = String(b.post.created_at || '').localeCompare(String(a.post.created_at || ''));
            if (ca !== 0) return ca;
            return String(b.post.id || '').localeCompare(String(a.post.id || ''));
          });

          let filtered = hybrid;
          if (numericCursor !== null && cursorCreatedAt) {
            filtered = hybrid.filter((h) => {
              const s = h.score;
              const ca = String(h.post.created_at || '');
              const id = String(h.post.id || '');
              return (
                s < numericCursor! ||
                (s === numericCursor && ca < cursorCreatedAt) ||
                (s === numericCursor && ca === cursorCreatedAt && id < cursorId!)
              );
            });
          }

          const page = diversifyPosts(filtered, limit, 3);
          const posts = page.map((h) => {
            const p = h.post;
            p.score = h.score;
            return p;
          });

          enrichedPosts = await enrichRecommendedPosts(posts, c.env.DB, currentUserId, c);
          if (enrichedPosts.length > 0) {
            const last = enrichedPosts[enrichedPosts.length - 1] as Record<string, unknown>;
            nextCursor = `${last.score},${last.created_at},${last.id}`;
          }
        }
      }
    }

    // Fallback: when no interest vector OR hybrid returned nothing
    if (enrichedPosts.length === 0) {
      const scoreFormula = `(p.engagement_hotness / EXP(1.5 * LN((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0)))`;
      const fetchLimit = limit * 5;
      const blockFilterRecommended = currentUserId
        ? 'AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)'
        : '';
      const blockParamRecommended = currentUserId ? [currentUserId] : [];

      // Fetch raw engagement-based candidates, then re-rank with quality/type/author weights
      const rawQuery = `${RECOMMENDED_SELECT}, ${scoreFormula} as score FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${currentUserId ? 'AND p.user_id != ?' : ''} ${blockFilterRecommended} ORDER BY score DESC, p.created_at DESC LIMIT ?`;
      const rawParams: Array<unknown> = currentUserId
        ? [currentUserId, ...blockParamRecommended, fetchLimit]
        : [...blockParamRecommended, fetchLimit];
      const result = await c.env.DB.prepare(rawQuery)
        .bind(...rawParams)
        .all();
      const rawPosts = (result.results || []) as Record<string, unknown>[];

      // Compute author quality scores
      const authorQualityMap = new Map<string, number>();
      const authorIds = [...new Set(rawPosts.map((p) => p.user_id as string))].filter(Boolean);
      if (authorIds.length > 0) {
        const authorRows = await c.env.DB.prepare(
          `SELECT u.id, u.display_name, u.bio, u.avatar_key, u.created_at,
              COALESCE(SUM(p.fresh_count), 0) as total_fresh,
              COALESCE(SUM(p.reply_count), 0) as total_reply,
              COALESCE(SUM(p.impressions), 0) as total_impressions,
              COUNT(p.id) as post_count
             FROM users u
             LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'published'
             WHERE u.id IN (${authorIds.map(() => '?').join(',')})
             GROUP BY u.id`,
        )
          .bind(...authorIds)
          .all<{
            id: string;
            display_name: string | null;
            bio: string | null;
            avatar_key: string | null;
            created_at: string;
            total_fresh: number;
            total_reply: number;
            total_impressions: number;
            post_count: number;
          }>();
        for (const row of authorRows.results || []) {
          const ageMs = Date.now() - new Date(row.created_at).getTime();
          const accountAgeDays = ageMs / 86400000;
          const postCount = row.post_count || 1;
          const authorQuality = computeAuthorQuality({
            freshRatio: (row.total_fresh || 0) / postCount / 5,
            replyRate: (row.total_reply || 0) / Math.max(row.total_impressions || postCount, 1),
            accountAgeDays: Math.max(accountAgeDays, 1),
            hasDisplayName: !!row.display_name,
            hasBio: !!row.bio,
            hasAvatar: !!row.avatar_key,
          });
          authorQualityMap.set(row.id, 0.5 + authorQuality);
        }
      }

      // Re-rank with quality score, type weights, and author quality
      const reranked = rawPosts.map((p) => {
        const qualityScore = computeQualityScore(String(p.text || ''), !!(p.payload_key || p.swf_key), 0);
        const typeFactor = (() => {
          const w = getTypeWeights(p.payload_key as string | null, p.swf_key as string | null);
          return (w.fresh + w.reply + w.impression) / 4.5;
        })();
        const authorQuality = authorQualityMap.get(p.user_id as string) || 1.0;
        const rawScore = Number(p.score) || 0;
        const fresh = freshnessBoost(p.created_at as string);
        return { post: p, score: rawScore * qualityScore * typeFactor * authorQuality * fresh };
      });

      // Cursor filter
      let filtered = reranked;
      if (numericCursor !== null && cursorCreatedAt) {
        filtered = reranked.filter((s) => {
          const ca = String(s.post.created_at || '');
          const id = String(s.post.id || '');
          return (
            s.score < numericCursor! ||
            (s.score === numericCursor && ca < cursorCreatedAt!) ||
            (s.score === numericCursor && ca === cursorCreatedAt && id < cursorId!)
          );
        });
      }

      filtered.sort((a, b) => {
        const diff = b.score - a.score;
        if (diff !== 0) return diff;
        const ca = String(b.post.created_at || '').localeCompare(String(a.post.created_at || ''));
        if (ca !== 0) return ca;
        return String(b.post.id || '').localeCompare(String(a.post.id || ''));
      });

      const diverse = diversifyPosts(filtered, limit, 3);
      const pagePosts = diverse.map((d) => {
        d.post.score = d.score;
        return d.post;
      });
      enrichedPosts = await enrichRecommendedPosts(pagePosts, c.env.DB, currentUserId, c);
      nextCursor =
        enrichedPosts.length > 0
          ? `${(enrichedPosts[enrichedPosts.length - 1] as Record<string, unknown>).score},${(enrichedPosts[enrichedPosts.length - 1] as Record<string, unknown>).created_at},${(enrichedPosts[enrichedPosts.length - 1] as Record<string, unknown>).id}`
          : null;
    }

    return c.json({ posts: enrichedPosts, next_cursor: nextCursor });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Recommended posts error:', error);
    return c.json({ error: 'Internal server error', details: err.message }, 500);
  }
});

async function enrichRecommendedPosts(
  posts: Record<string, unknown>[],
  db: D1Database,
  currentUserId: string | null | undefined,
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): Promise<Record<string, unknown>[]> {
  if (posts.length === 0) return [];
  if (currentUserId) {
    const postIds = posts.map((p) => String(p.id));
    const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(db, currentUserId, postIds);
    posts.forEach((p) => {
      p.is_freshed = freshed.has(p.id as string);
      p.is_bookmarked = bookmarked.has(p.id as string);
    });
  }
  await enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId);
  await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
  await enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId);
  return posts;
}

// GET /api/posts/:id/similar - get similar posts based on vector embedding
app.get('/api/posts/:id/similar', async (c) => {
  try {
    const postId = c.req.param('id');
    const limit = Math.min(Number(c.req.query('limit') || '5'), 20);
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const currentUserId = c.get('user')?.id;

    // Get the post's embedding
    const embedRow = await c.env.DB.prepare('SELECT embedding FROM post_embeddings WHERE post_id = ?')
      .bind(postId)
      .first<{ embedding: string }>();
    if (!embedRow) return c.json({ posts: [] });

    let vector: number[];
    try {
      vector = JSON.parse(embedRow.embedding);
    } catch {
      return c.json({ posts: [] });
    }
    if (!Array.isArray(vector)) return c.json({ posts: [] });

    // Query Vectorize
    let similarIds: string[] = [];
    const vectorize = c.env.VECTORIZE;
    if (vectorize) {
      try {
        const result = await vectorize.query(vector, { topK: limit + 1, returnValues: false, returnMetadata: false });
        similarIds = (result.matches || [])
          .map((m) => m.id)
          .filter((id) => id !== postId)
          .slice(0, limit);
      } catch (e) {
        console.error('Vectorize query for similar failed:', e);
      }
    }

    // Fallback: D1 cosine similarity
    if (similarIds.length === 0) {
      const allRows = await c.env.DB.prepare(
        'SELECT post_id, embedding FROM post_embeddings ORDER BY created_at DESC LIMIT 100',
      ).all<{
        post_id: string;
        embedding: string;
      }>();
      const scored: Array<{ id: string; sim: number }> = [];
      for (const row of allRows.results || []) {
        if (row.post_id === postId) continue;
        try {
          const v = JSON.parse(row.embedding);
          if (Array.isArray(v)) scored.push({ id: row.post_id, sim: cosineSimilarity(vector, v) });
        } catch {
          /* skip */
        }
      }
      scored.sort((a, b) => b.sim - a.sim);
      similarIds = scored.slice(0, limit).map((s) => s.id);
    }

    if (similarIds.length === 0) return c.json({ posts: [] });

    const postsResult = await c.env.DB.prepare(
      `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id IN (${similarIds.map(() => '?').join(',')})`,
    )
      .bind(...similarIds)
      .all();
    const posts = postsResult.results || [];

    if (currentUserId && posts.length > 0) {
      const pids = posts.map((p: Record<string, unknown>) => String(p.id));
      const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, pids);
      posts.forEach((p: Record<string, unknown>) => {
        p.is_freshed = freshed.has(p.id as string);
        p.is_bookmarked = bookmarked.has(p.id as string);
      });
    }

    await enrichPostsWithPolls(posts as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
    await enrichPostsWithReactions(posts as PostRow[], c.env.DB, currentUserId);

    return c.json({ posts });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Similar posts error:', error);
    return c.json({ error: 'Internal server error', details: err.message }, 500);
  }
});

// GET /api/ads/active - get active ads (public endpoint)
app.get('/api/ads/active', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(
      'SELECT id, body_text, payload_key, payload_type, thumbnail_key, click_url, impressions, clicks, active, created_at, ad_type FROM ads WHERE active = 1',
    ).all();

    if (!result.success) {
      console.error('Database query failed:', result);
      return c.json({ error: 'Failed to fetch ads' }, 500);
    }

    // Shuffle results in JS
    const shuffled = [...(result.results || [])].sort(() => Math.random() - 0.5);

    return c.json({ ads: shuffled });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Get active ads error:', error);
    return c.json({ error: 'Failed to get active ads', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/ads/:id/impression - track ad impression (public endpoint)
app.post('/api/ads/:id/impression', async (c) => {
  try {
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ?').bind(adId).run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to record impression' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record impression error:', error);
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({ ok: true, warning: 'Impression tracking failed but content can still be displayed' });
  }
});

// POST /api/posts/:id/impression - track post impression (public endpoint)
app.post('/api/posts/:id/impression', async (c) => {
  try {
    const postId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(
      'UPDATE posts SET impressions = impressions + 1, engagement_hotness = engagement_hotness + 0.1 WHERE id = ?',
    )
      .bind(postId)
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to record impression' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record post impression error:', error);
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({ ok: true, warning: 'Impression tracking failed but content can still be displayed' });
  }
});

// POST /api/posts/impressions/batch - track multiple post impressions (public endpoint)
app.post('/api/posts/impressions/batch', async (c) => {
  try {
    const body = (await c.req.json()) as { post_ids: string[] };

    if (!body.post_ids || !Array.isArray(body.post_ids) || body.post_ids.length === 0) {
      return c.json({ error: 'Invalid request: post_ids array required' }, 400);
    }

    if (body.post_ids.length > 100) {
      return c.json({ error: 'Too many post IDs (max 100)' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Create placeholders for batch update
    const placeholders = body.post_ids.map(() => '?').join(',');
    const result = await c.env.DB.prepare(
      `UPDATE posts SET impressions = impressions + 1, engagement_hotness = engagement_hotness + 0.1 WHERE id IN (${placeholders})`,
    )
      .bind(...body.post_ids)
      .run();

    if (!result.success) {
      console.error('Batch database update failed:', result);
      return c.json({ error: 'Failed to record impressions' }, 500);
    }

    return c.json({ ok: true, updated: result.meta?.changes || 0 });
  } catch (error: unknown) {
    console.error('Batch post impressions error:', error);
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({
      ok: true,
      updated: 0,
      warning: 'Batch impression tracking failed but content can still be displayed',
    });
  }
});

// POST /api/ads/:id/click - track ad click (public endpoint)
app.post('/api/ads/:id/click', async (c) => {
  try {
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').bind(adId).run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to record click' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record click error:', error);
    // Always return success to ensure content display continues
    // even if click tracking fails
    return c.json({ ok: true, warning: 'Click tracking failed but content can still be displayed' });
  }
});

// POST /api/ads/:id/interaction - track ad interaction (public endpoint)
app.post('/api/ads/:id/interaction', async (c) => {
  try {
    const adId = c.req.param('id');
    const { duration_ms } = await c.req.json();

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare('INSERT INTO ad_interactions (id, ad_id, duration_ms) VALUES (?, ?, ?)')
      .bind(nanoid(), adId, duration_ms)
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to record interaction' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record interaction error:', error);
    // Always return success to ensure content display continues
    // even if interaction tracking fails
    return c.json({ ok: true, warning: 'Interaction tracking failed but content can still be displayed' });
  }
});

// POST /api/ads/:id/play - track game play start (public endpoint)
app.post('/api/ads/:id/play', async (c) => {
  try {
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Record a 0-duration interaction to track play count
    const result = await c.env.DB.prepare('INSERT INTO ad_interactions (id, ad_id, duration_ms) VALUES (?, ?, 0)')
      .bind(nanoid(), adId)
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to record play' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record play error:', error);
    // Always return success to ensure content display continues
    // even if play tracking fails
    return c.json({ ok: true, warning: 'Play tracking failed but content can still be displayed' });
  }
});

// Admin middleware helper
const requireAdmin = async (c: Context, next: Next) => {
  const username = c.get('user')?.username;
  if (!username || !isAdmin(c.env as { ADMIN_USERNAMES: string }, username)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};

// PUT /api/ads/:id - update ad (for PATCH-like updates)
app.put('/api/ads/:id', requireAdmin, async (c) => {
  try {
    const adId = c.req.param('id');
    const body = await c.req.json();

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Build UPDATE query dynamically
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (body.title !== undefined) {
      updates.push('title = ?');
      values.push(body.title);
    }
    if (body.body_text !== undefined) {
      updates.push('body_text = ?');
      values.push(body.body_text);
    }
    if (body.click_url !== undefined) {
      updates.push('click_url = ?');
      values.push(body.click_url);
    }
    if (body.active !== undefined) {
      updates.push('active = ?');
      values.push(body.active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    values.push(adId ?? '');

    const result = await c.env.DB.prepare(`
      UPDATE ads SET ${updates.join(', ')} WHERE id = ?
    `)
      .bind(...values)
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to update ad' }, 500);
    }

    // Return updated ad
    const updatedAd = await c.env.DB.prepare('SELECT * FROM ads WHERE id = ?').bind(adId).first();

    return c.json({ ad: updatedAd });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Update ad error:', error);
    return c.json({ error: 'Failed to update ad', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/posts/:id/prepare-attachment — generate upload URL for editing existing post attachments (protected)
app.post('/api/posts/:id/prepare-attachment', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id');
    const { filename } = await c.req.json();

    if (!filename) return c.json({ error: 'Missing filename' }, 400);

    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const post = await c.env.DB.prepare('SELECT id, user_id, status FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ id: string; user_id: string; status: string } | null>();

    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Cannot edit this post' }, 400);

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];

    let storageKey: string;
    let keyType: string;

    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `swf/${postId}.swf`;
      keyType = 'swf';
    } else if (name.endsWith('.zip')) {
      storageKey = `zip/${postId}.zip`;
      keyType = 'payload';
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `html/${postId}.html`;
      keyType = 'payload';
    } else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `audio/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `video/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = {
        png: '.png',
        jpg: '.jpg',
        jpeg: '.jpg',
        gif: '.gif',
        webp: '.webp',
        svg: '.svg',
        bmp: '.bmp',
        ico: '.ico',
      };
      storageKey = `gif/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else {
      const safeExt = ext ? `.${ext}` : '';
      storageKey = `payload/${postId}${safeExt}`;
      keyType = 'payload';
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;

    return c.json({ uploadUrl, key: storageKey, keyType });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Prepare attachment error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// Step 1 — POST /api/posts/prepare (protected)
app.post('/api/posts/prepare', requireAuth, async (c) => {
  try {
    const { filename } = await c.req.json();

    if (!filename) {
      return c.json({ error: 'Missing filename' }, 400);
    }

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];
    const postId = crypto.randomUUID();

    let storageKey: string;
    let keyColumn: string;
    let responseType: 'gif' | 'zip' | 'swf';

    // SWF files
    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `swf/${postId}.swf`;
      keyColumn = 'swf_key';
      responseType = 'swf';
    }
    // ZIP files
    else if (name.endsWith('.zip')) {
      storageKey = `zip/${postId}.zip`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }
    // HTML files
    else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `html/${postId}.html`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }
    // Audio files by extension
    else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `audio/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Video files by extension
    else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `video/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Image files by extension
    else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = {
        png: '.png',
        jpg: '.jpg',
        jpeg: '.jpg',
        gif: '.gif',
        webp: '.webp',
        svg: '.svg',
        bmp: '.bmp',
        ico: '.ico',
      };
      storageKey = `gif/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Fallback: store as generic payload with original extension
    else {
      const safeExt = ext ? `.${ext}` : '';
      storageKey = `payload/${postId}${safeExt}`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, ${keyColumn}, engagement_hotness, status)
      VALUES (?, ?, ?, ?, ?, ?, 1.0, 'pending')
    `)
      .bind(postId, c.get('user')?.id || '', c.get('user')?.username || 'anonymous', '', '[]', storageKey)
      .run();

    if (!result.success) {
      return c.json({ error: 'Failed to create pending post' }, 500);
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;
    const resp: Record<string, unknown> = { postId };

    if (responseType === 'zip') {
      resp.zipUploadUrl = uploadUrl;
      resp.zipKey = storageKey;
    } else if (responseType === 'swf') {
      resp.swfUploadUrl = uploadUrl;
      resp.swfKey = storageKey;
    } else {
      resp.gifUploadUrl = uploadUrl;
      resp.gifKey = storageKey;
    }

    return c.json(resp);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Prepare post error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// Helper: extract game description from a game ZIP in R2
async function extractGameDescription(
  bucket: R2Bucket,
  db: D1Database,
  payloadKey: string,
  postId: string,
): Promise<void> {
  try {
    const result = await extractFileFromZip(bucket, payloadKey, 'index.html');
    if (!result) return;
    const decoder = new TextDecoder('utf-8');
    const html = decoder.decode(result.data);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const contentMatch = (attrValue: string): string => {
      const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["']`, 'i'),
        new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`, 'i'),
      ];
      for (const pattern of patterns) {
        const m = html.match(pattern);
        if (m && m[1].trim()) return m[1].trim();
      }
      return '';
    };

    const metaDesc =
      contentMatch('description') || contentMatch('og:description') || contentMatch('twitter:description');
    const gameDescription = metaDesc || title || '';
    if (gameDescription) {
      const cleaned = gameDescription
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) {
        await db
          .prepare('UPDATE posts SET game_description = ? WHERE id = ?')
          .bind(cleaned.slice(0, 500), postId)
          .run();
      }
    }
  } catch (e) {
    console.error(`Failed to extract game description for post ${postId}:`, e);
  }
}

// Step 3 — POST /api/posts/commit (protected)
app.post('/api/posts/commit', requireAuth, async (c) => {
  try {
    const contentType = c.req.header('content-type');
    let postId: string | undefined;
    let gifKey: string | undefined;
    let swfKey: string | undefined;
    let text: string;
    let requestHashtags: string[] = [];
    let pollData: any;
    let zipKey: string | undefined;
    let thumbnailKey: string | undefined;
    let quotedPostId: string | undefined;

    if (contentType?.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      text = formData.get('text') as string;
      postId = (formData.get('postId') as string) || undefined;
      gifKey = (formData.get('gifKey') as string) || undefined;
      swfKey = (formData.get('swfKey') as string) || undefined;
      zipKey = (formData.get('payloadKey') as string) || undefined;
      quotedPostId = (formData.get('quotedPostId') as string) || undefined;
      const pollStr = formData.get('poll') as string;
      pollData = pollStr ? JSON.parse(pollStr) : undefined;

      const thumbnailFile = (formData.get('thumbnail') as File | null) || undefined;
      if (thumbnailFile && thumbnailFile.size > 0) {
        if (thumbnailFile.size > 1024 * 1024) {
          return c.json({ error: 'Thumbnail must be ≤1MB' }, 400);
        }
        const allowedExts = ['jpg', 'jpeg', 'png', 'gif'];
        const ext = thumbnailFile.name.toLowerCase().split('.').pop();
        if (!ext || !allowedExts.includes(ext)) {
          return c.json({ error: 'Thumbnail must be .jpg, .jpeg, .png, or .gif' }, 400);
        }
        const thumbnailR2Key = `payload/${postId || crypto.randomUUID()}.thumb.${ext}`;
        const thumbnailBuffer = await thumbnailFile.arrayBuffer();
        const thumbnailDimError = validateImageDimensions(thumbnailBuffer, thumbnailFile.type);
        if (thumbnailDimError) {
          return c.json({ error: `Thumbnail too large. ${thumbnailDimError}` }, 413);
        }
        await c.env.BUCKET.put(thumbnailR2Key, thumbnailBuffer, {
          httpMetadata: { contentType: thumbnailFile.type },
        });
        thumbnailKey = thumbnailR2Key;
      }
    } else {
      const body = await c.req.json();
      postId = body.postId;
      gifKey = body.gifKey;
      swfKey = body.swfKey;
      text = body.text;
      requestHashtags = body.hashtags || [];
      pollData = body.poll;
      zipKey = body.zipKey;
      thumbnailKey = body.thumbnailKey;
      quotedPostId = body.quotedPostId;
    }
    const payloadKey = zipKey;
    const userId = c.get('user')?.id || '';
    const username = c.get('user')?.username || 'anonymous';

    // Validate text (empty allowed only for quotes)
    const hasQuote = Boolean(quotedPostId);
    if (!text) text = '';
    if (text.length > 200 || (!hasQuote && text.length < 1)) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422);
    }

    // Validate hashtags
    if (!Array.isArray(requestHashtags) || requestHashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422);
    }

    for (const tag of requestHashtags) {
      if (
        typeof tag !== 'string' ||
        tag.length > 20 ||
        !/^[a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(tag)
      ) {
        return c.json({ error: 'Hashtags must be alphanumeric, Japanese characters, and ≤20 chars' }, 422);
      }
    }

    // Extract hashtags from text
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
    const hashtagSet = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtagSet.add(match[1]);
    }
    const hashtags = Array.from(hashtagSet);

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
    const mentionSet = new Set<string>();
    let mentionMatch: RegExpExecArray | null;
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1]);
    }
    const mentionedUsernames = Array.from(mentionSet);

    // Resolve mentions
    const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, username);

    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available');
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate quoted post reference if provided
    let quotedPostAuthorId: string | null = null;
    if (quotedPostId) {
      const quoted = (await c.env.DB.prepare('SELECT id, user_id, status FROM posts WHERE id = ?')
        .bind(quotedPostId)
        .first()) as { id: string; user_id: string; status: string } | null;

      if (!quoted || quoted.status !== 'published') {
        return c.json({ error: 'Quoted post not found' }, 404);
      }
      quotedPostAuthorId = quoted.user_id;
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, payload_key, gif_key, swf_key, thumbnail_key, quoted_post_id, engagement_hotness, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 'published')
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        hashtags = excluded.hashtags,
        mentions = excluded.mentions,
        payload_key = COALESCE(excluded.payload_key, posts.payload_key),
        gif_key = COALESCE(excluded.gif_key, posts.gif_key),
        swf_key = COALESCE(excluded.swf_key, posts.swf_key),
        thumbnail_key = COALESCE(excluded.thumbnail_key, posts.thumbnail_key),
        quoted_post_id = COALESCE(excluded.quoted_post_id, posts.quoted_post_id),
        status = 'published'
    `)
      .bind(
        postId,
        userId,
        username,
        text,
        JSON.stringify(hashtags),
        mentionsJson,
        payloadKey || null,
        gifKey || null,
        swfKey || null,
        thumbnailKey || null,
        quotedPostId || null,
      )
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to create post', details: result }, 500);
    }

    // Create poll if poll data was provided
    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      try {
        const pollId = crypto.randomUUID();
        await c.env.DB.prepare(`
          INSERT INTO polls (id, post_id, question, multiple_choice, ends_at)
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(pollId, postId, pollData.question, pollData.multipleChoice ? 1 : 0, pollData.endsAt || null)
          .run();

        const optionIds: string[] = [];
        const optionStmts = pollData.options.map((label: string) => {
          const optId = crypto.randomUUID();
          optionIds.push(optId);
          return c.env.DB.prepare('INSERT INTO poll_options (id, poll_id, label) VALUES (?, ?, ?)').bind(
            optId,
            pollId,
            label,
          );
        });
        await c.env.DB.batch(optionStmts);
      } catch (e) {
        console.error('Failed to create poll:', e);
        // Don't fail post creation if poll creation fails
      }
    }

    // Create mention notifications for mentioned users (skip self-mentions)
    if (mentionedUsernames.length > 0) {
      try {
        const mentionData = JSON.parse(mentionsJson) as Array<{ username: string; user_id: string }>;
        const mentionStmts = mentionData
          .filter((m) => m.user_id !== userId)
          .map((m) =>
            c.env.DB.prepare(
              'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
            ).bind(nanoid(), m.user_id, 'mention', postId, userId),
          );
        if (mentionStmts.length > 0) {
          await c.env.DB.batch(mentionStmts);
        }
        for (const mention of mentionData) {
          if (mention.user_id === userId) continue;
          const actor = c.get('user');
          await sendPushToAll(
            c.env,
            mention.user_id,
            'mention',
            actor?.username,
            actor?.display_name,
            text || '',
            postId,
          );
        }
      } catch (e) {
        // Don't fail the post creation if mention notifications fail
        console.error('Failed to create mention notifications:', e);
      }
    }

    // Create quote notification for the quoted post's author (skip self-quotes)
    if (quotedPostAuthorId && quotedPostAuthorId !== userId) {
      try {
        await c.env.DB.prepare(
          'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(nanoid(), quotedPostAuthorId, 'quote', postId, userId)
          .run();
        const actor = c.get('user');
        await sendPushToAll(
          c.env,
          quotedPostAuthorId,
          'quote',
          actor?.username,
          actor?.display_name,
          text || '',
          postId,
        );
      } catch (e) {
        console.error('Failed to create quote notification:', e);
      }
    }

    // ActivityPub delivery for public posts
    try {
      // Get user info for ActivityPub
      const user = (await c.env.DB.prepare('SELECT id, username, display_name FROM users WHERE id = ?')
        .bind(userId)
        .first()) as { id: string; username: string; display_name: string } | null;

      if (user && c.env.AP_DELIVERY_QUEUE) {
        // Get post details including mentions
        const post = (await c.env.DB.prepare('SELECT id, text, created_at, status, mentions FROM posts WHERE id = ?')
          .bind(postId)
          .first()) as {
          id: string;
          text: string;
          created_at: string;
          status: string;
          mentions: string | null;
        } | null;

        if (post && post.status === 'published') {
          // Build mention actor URLs for CC
          const mentionActorUrls: string[] = [];
          try {
            if (post.mentions) {
              const mentionData = JSON.parse(post.mentions) as Array<{ username: string; user_id: string }>;
              for (const m of mentionData) {
                mentionActorUrls.push(`${c.env.BASE_URL}/actors/${m.username}`);
              }
            }
          } catch {}
          const note = buildNoteObject(post, user, c.env.BASE_URL, mentionActorUrls);
          const activity = buildCreateActivity(note, user, c.env.BASE_URL);

          // Get followers from ap_followers
          const followers = (await c.env.DB.prepare('SELECT inbox_url FROM ap_followers WHERE local_user_id = ?')
            .bind(userId)
            .all()) as { results: Array<{ inbox_url: string }> };

          // Send to queue for each follower
          for (const follower of followers.results) {
            await c.env.AP_DELIVERY_QUEUE.send({
              inboxUrl: follower.inbox_url,
              activity,
              senderUsername: username,
            });
          }
        }
      }
    } catch (e) {
      // Queue not available or other error - skip delivery in development
      console.error('ActivityPub delivery skipped:', String(e));
    }

    // Extract game description from ZIP
    if (payloadKey && payloadKey.endsWith('.zip')) {
      await extractGameDescription(c.env.BUCKET, c.env.DB, payloadKey!, postId!);
    }

    // Fetch the created post for enrichment
    const fullPost = (await c.env.DB.prepare(
      "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key as payloadKey, p.swf_key as swfKey, p.thumbnail_key as thumbnailKey, p.game_description, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?",
    )
      .bind(postId)
      .first()) as PostRow;

    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      try {
        await enrichPostsWithPolls([fullPost], c.env.DB, c.get('user')?.id);
      } catch (e) {
        console.error('Failed to enrich post with poll:', e);
      }
    }

    await enrichPostsWithQuotes([fullPost], c.env.DB);
    await enrichPostsWithReactions([fullPost], c.env.DB, c.get('user')?.id);

    embedPost(
      c.env.DB,
      c.env.CROWD_ORCHESTRATOR_URL,
      c.env.CROWD_API_KEY,
      c.env.BASE_URL,
      fullPost.id,
      fullPost.text,
    ).catch((e) => console.error('Background embed failed:', e));

    submitDetectNsfw(
      c.env.DB,
      c.env.CROWD_ORCHESTRATOR_URL,
      c.env.CROWD_API_KEY,
      c.env.BASE_URL,
      fullPost.id,
      fullPost.gif_key,
    );

    // Pre-extract ZIP to R2 for WVFS persistent caching
    if (payloadKey && payloadKey.endsWith('.zip')) {
      const execCtx = (c as any).executionCtx;
      if (execCtx?.waitUntil) {
        execCtx.waitUntil(
          (async () => {
            try {
              await extractZipToR2(c.env.BUCKET, payloadKey!, postId!);
            } catch (e) {
              console.error('Background ZIP extraction failed:', e);
            }
          })(),
        );
      }
    }

    // Pre-copy HTML to WVFS for persistent caching
    if (payloadKey && payloadKey.endsWith('.html')) {
      const execCtx = (c as any).executionCtx;
      if (execCtx?.waitUntil) {
        execCtx.waitUntil(
          (async () => {
            try {
              await copyHtmlToWvfs(c.env.BUCKET, payloadKey!, postId!);
            } catch (e) {
              console.error('Background HTML copy failed:', e);
            }
          })(),
        );
      }
    }

    return c.json({ post: fullPost });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Post creation error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/posts/:id/fresh - toggle Fresh! (protected)
app.post('/api/posts/:id/fresh', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const userId = c.get('user')?.id || '';
  const currentUser = c.get('user');

  // Get post to check ownership for notification and remote actor
  const post = (await c.env.DB.prepare(
    "SELECT user_id, actor_id, username, text FROM posts WHERE id = ? AND status = 'published'",
  )
    .bind(postId)
    .first()) as { user_id: string; actor_id: string | null; username: string; text: string } | null;

  if (!post) {
    return c.json({ error: 'Post not found' }, 404);
  }

  // Check if already freshed
  const existing = await c.env.DB.prepare('SELECT * FROM freshs WHERE post_id = ? AND user_id = ?')
    .bind(postId, userId)
    .first();

  if (existing) {
    // Remove fresh
    await c.env.DB.prepare('DELETE FROM freshs WHERE post_id = ? AND user_id = ?').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count - 1, engagement_hotness = engagement_hotness - 2.0 WHERE id = ? RETURNING fresh_count',
    )
      .bind(postId)
      .first<{ fresh_count: number }>();

    return c.json({ freshed: false, fresh_count: result?.fresh_count ?? 0 });
  } else {
    // Add fresh
    await c.env.DB.prepare('INSERT INTO freshs (post_id, user_id) VALUES (?, ?)').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count + 1, engagement_hotness = engagement_hotness + 2.0 WHERE id = ? RETURNING fresh_count',
    )
      .bind(postId)
      .first<{ fresh_count: number }>();

    // Create notification for post author (only if not self-freshing)
    if (post.user_id !== userId) {
      try {
        const existingNotif = (await c.env.DB.prepare(
          "SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = 'fresh' ORDER BY created_at DESC LIMIT 1",
        )
          .bind(post.user_id, postId)
          .first()) as Record<string, unknown>;

        if (existingNotif) {
          const actorData = existingNotif.actor_data
            ? JSON.parse(existingNotif.actor_data as string)
            : existingNotif.actor_id
              ? [existingNotif.actor_id as string]
              : [];
          if (!actorData.includes(userId)) {
            actorData.push(userId);
          }
          await c.env.DB.prepare(
            "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
          )
            .bind(actorData[0], JSON.stringify(actorData), existingNotif.id as string)
            .run();
        } else {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          )
            .bind(nanoid(), post.user_id, 'fresh', postId, userId)
            .run();
          {
            const actor = c.get('user');

            const textPreview = ((post as Record<string, unknown>).text as string) || '';
            await sendPushToAll(
              c.env,
              post.user_id,
              'fresh',
              actor?.username,
              actor?.display_name,
              textPreview,
              postId,
            );
          }
        }
      } catch (e) {
        console.error('Failed to create fresh notification:', e);
      }
    }

    // If the post is from a remote actor, send Like activity
    if (post.actor_id && currentUser && c.env.AP_DELIVERY_QUEUE) {
      try {
        const actorResponse = await fetch(post.actor_id, {
          headers: { Accept: 'application/activity+json, application/ld+json' },
        });
        if (actorResponse.ok) {
          const actorData = (await actorResponse.json()) as ActorData;
          const inboxUrl = actorData.inbox;
          if (inboxUrl) {
            const likeActivity = {
              '@context': 'https://www.w3.org/ns/activitystreams',
              id: `${c.env.BASE_URL}/activities/like-${nanoid()}`,
              type: 'Like',
              actor: `${c.env.BASE_URL}/actors/${currentUser.username}`,
              object: `${c.env.BASE_URL}/notes/${postId}`,
              to: [post.actor_id],
            };
            await c.env.AP_DELIVERY_QUEUE.send({
              type: 'delivery',
              inboxUrl,
              activity: likeActivity,
              senderUsername: currentUser.username,
            });
          }
        }
      } catch (e) {
        console.error('Failed to send Like activity for remote post:', e);
      }
    }

    return c.json({ freshed: true, fresh_count: result?.fresh_count ?? 0 });
  }
});

// POST /api/posts/:id/bookmark - toggle bookmark (protected)
app.post('/api/posts/:id/bookmark', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const userId = c.get('user')?.id || '';

  // Verify post exists
  const post = (await c.env.DB.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'")
    .bind(postId)
    .first()) as { id: string } | null;

  if (!post) {
    return c.json({ error: 'Post not found' }, 404);
  }

  // Check if already bookmarked
  const existing = await c.env.DB.prepare('SELECT * FROM bookmarks WHERE post_id = ? AND user_id = ?')
    .bind(postId, userId)
    .first();

  if (existing) {
    await c.env.DB.prepare('DELETE FROM bookmarks WHERE post_id = ? AND user_id = ?').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET bookmark_count = bookmark_count - 1 WHERE id = ? RETURNING bookmark_count',
    )
      .bind(postId)
      .first<{ bookmark_count: number }>();

    return c.json({ bookmarked: false, bookmark_count: result?.bookmark_count ?? 0 });
  } else {
    await c.env.DB.prepare('INSERT INTO bookmarks (post_id, user_id) VALUES (?, ?)').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET bookmark_count = bookmark_count + 1 WHERE id = ? RETURNING bookmark_count',
    )
      .bind(postId)
      .first<{ bookmark_count: number }>();

    return c.json({ bookmarked: true, bookmark_count: result?.bookmark_count ?? 0 });
  }
});

// POST /api/posts/:id/reactions - toggle an emoji reaction on a post (protected)
app.post('/api/posts/:id/reactions', requireAuth, async (c) => {
  try {
    await ensureReactionsTable(c.env.DB);
    const postId = c.req.param('id');
    const userId = c.get('user')?.id || '';
    const { emoji } = (await c.req.json()) as { emoji?: string };

    if (typeof emoji !== 'string' || emoji.trim().length === 0) {
      return c.json({ error: 'Invalid emoji' }, 400);
    }
    const cleanEmoji = emoji.trim();
    if (cleanEmoji.length > 32) {
      return c.json({ error: 'Emoji too long' }, 400);
    }

    // Verify post exists
    const post = (await c.env.DB.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'")
      .bind(postId)
      .first()) as { id: string } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const existing = await c.env.DB.prepare('SELECT 1 FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?')
      .bind(postId, userId, cleanEmoji)
      .first();

    if (existing) {
      await c.env.DB.prepare('DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?')
        .bind(postId, userId, cleanEmoji)
        .run();
    } else {
      await c.env.DB.prepare('INSERT INTO reactions (post_id, user_id, emoji) VALUES (?, ?, ?)')
        .bind(postId, userId, cleanEmoji)
        .run();
    }

    const postRow = { id: postId } as PostRow;
    await enrichPostsWithReactions([postRow], c.env.DB, userId);

    return c.json({
      emoji: cleanEmoji,
      reacted: !existing,
      reactions: postRow.reactions || [],
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Reaction toggle error:', error);
    return c.json({ error: 'Failed to toggle reaction', details: err.message }, 500);
  }
});

// ─── Custom Stamps API ────────────────────────────────────────────────────────

// GET /api/stamps - list current user's custom stamps (protected)
app.get('/api/stamps', requireAuth, async (c) => {
  try {
    await ensureCustomStampsTable(c.env.DB);
    const userId = c.get('user')?.id || '';
    const rows = await c.env.DB.prepare(
      'SELECT id, name, image_key, created_at FROM custom_stamps WHERE user_id = ? ORDER BY created_at DESC',
    )
      .bind(userId)
      .all<{ id: string; name: string; image_key: string; created_at: string }>();

    const stamps = (rows.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      url: `/api/images/${r.image_key}`,
      created_at: r.created_at,
    }));

    return c.json({ stamps });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('List stamps error:', error);
    return c.json({ error: 'Failed to list stamps', details: err.message }, 500);
  }
});

// POST /api/stamps - upload a new custom stamp (protected, multipart/form-data)
app.post('/api/stamps', requireAuth, async (c) => {
  try {
    await ensureCustomStampsTable(c.env.DB);
    const userId = c.get('user')?.id || '';

    // Check plan for stamp limit
    const sub =
      (await c.env.DB.prepare(
        "SELECT plan_id FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1",
      )
        .bind(userId)
        .first<{ plan_id: string }>()) || null;

    const isPlus =
      sub?.plan_id === 'flaxia_plus' || sub?.plan_id === 'flaxia_plus_plus' || sub?.plan_id === 'flaxia_sharp';

    if (!isPlus) {
      const countRow = await c.env.DB.prepare('SELECT COUNT(*) AS cnt FROM custom_stamps WHERE user_id = ?')
        .bind(userId)
        .first<{ cnt: number }>();
      if ((countRow?.cnt ?? 0) >= 5) {
        return c.json({ error: 'Free plan limited to 5 custom stamps' }, 403);
      }
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const rawName = ((formData.get('name') as string) || '').trim();

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file provided' }, 400);
    }
    if (!rawName || rawName.length === 0) {
      return c.json({ error: 'Name is required' }, 400);
    }
    // Strip surrounding colons if user provided them
    const bareName = rawName.replace(/^:+|:+$/g, '');
    if (bareName.length === 0 || bareName.length > 30) {
      return c.json({ error: 'Name too long (max 30 chars)' }, 400);
    }
    if (!/^[a-zA-Z0-9_]+$/.test(bareName)) {
      return c.json({ error: 'Name must contain only letters, numbers, and underscores' }, 400);
    }
    // Store as :name: — ownership checked at render time
    const name = `:${bareName}:`;

    // Check unique name per user
    const existing = await c.env.DB.prepare('SELECT 1 FROM custom_stamps WHERE user_id = ? AND name = ?')
      .bind(userId, name)
      .first();
    if (existing) {
      return c.json({ error: 'A stamp with this name already exists' }, 409);
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      return c.json({ error: 'File too large (max 5MB)' }, 400);
    }

    const fileData = await file.arrayBuffer();
    const detectedMime = detectMimeType(fileData);
    if (!isAllowedImageMime(detectedMime)) {
      return c.json({ error: 'Invalid image format. Allowed: PNG, JPEG, GIF, WebP' }, 400);
    }

    const ext =
      detectedMime === 'image/jpeg'
        ? 'jpg'
        : detectedMime === 'image/png'
          ? 'png'
          : detectedMime === 'image/gif'
            ? 'gif'
            : 'webp';
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    const r2Key = `stamp/${userId}/${hashHex}.${ext}`;

    await c.env.BUCKET.put(r2Key, fileData, {
      httpMetadata: { contentType: detectedMime },
    });

    const stampId = nanoid();
    await c.env.DB.prepare('INSERT INTO custom_stamps (id, user_id, name, image_key) VALUES (?, ?, ?, ?)')
      .bind(stampId, userId, name, r2Key)
      .run();

    return c.json(
      {
        id: stampId,
        name,
        url: `/api/images/${r2Key}`,
      },
      201,
    );
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Upload stamp error:', error);
    return c.json({ error: 'Failed to upload stamp', details: err.message }, 500);
  }
});

// DELETE /api/stamps/:id - delete a custom stamp (protected)
app.delete('/api/stamps/:id', requireAuth, async (c) => {
  try {
    await ensureCustomStampsTable(c.env.DB);
    const userId = c.get('user')?.id || '';
    const stampId = c.req.param('id');

    const stamp = await c.env.DB.prepare('SELECT id, image_key FROM custom_stamps WHERE id = ? AND user_id = ?')
      .bind(stampId, userId)
      .first<{ id: string; image_key: string }>();

    if (!stamp) {
      return c.json({ error: 'Stamp not found' }, 404);
    }

    await c.env.BUCKET.delete(stamp.image_key);
    await c.env.DB.prepare('DELETE FROM custom_stamps WHERE id = ?').bind(stampId).run();

    return c.json({ deleted: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Delete stamp error:', error);
    return c.json({ error: 'Failed to delete stamp', details: err.message }, 500);
  }
});

// GET /api/stamps/all - list all custom stamps (for stamp picker, public)
app.get('/api/stamps/all', async (c) => {
  try {
    await ensureCustomStampsTable(c.env.DB);
    const rows = await c.env.DB.prepare(
      'SELECT cs.id, cs.name, cs.image_key, cs.user_id, u.username FROM custom_stamps cs JOIN users u ON cs.user_id = u.id ORDER BY cs.created_at DESC',
    ).all<{ id: string; name: string; image_key: string; user_id: string; username: string }>();

    const stamps = (rows.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      url: `/api/images/${r.image_key}`,
      user_id: r.user_id,
      username: r.username,
    }));

    return c.json({ stamps });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('List all stamps error:', error);
    return c.json({ error: 'Failed to list stamps', details: err.message }, 500);
  }
});

// GET /api/bookmarks - get bookmarked posts for current user (protected)
app.get('/api/bookmarks', requireAuth, async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const userId = c.get('user')?.id || '';

    let query: string;
    const params: Array<unknown> = [userId];

    if (cursor) {
      params.push(cursor);
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN bookmarks b ON b.post_id = p.id AND b.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 AND p.created_at < ?
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
    } else {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN bookmarks b ON b.post_id = p.id AND b.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();
    const posts = result.results || [];

    // All posts fetched from bookmarks are by definition bookmarked
    posts.forEach((post: Record<string, unknown>) => {
      post.is_bookmarked = true;
    });

    await enrichPostsWithQuotes(posts as PostRow[], c.env.DB);
    await enrichPostsWithReactions(posts as PostRow[], c.env.DB, userId);

    const nextCursor = posts.length === limit ? posts[posts.length - 1].created_at : null;

    return c.json({ posts, nextCursor });
  } catch (error: unknown) {
    console.error('Bookmarks fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/freshs - get current user's Freshed (liked) posts (protected)
app.get('/api/freshs', requireAuth, async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);
    const userId = c.get('user')?.id || '';

    let query: string;
    const params: Array<unknown> = [userId];

    if (cursor) {
      params.push(cursor);
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN freshs f ON f.post_id = p.id AND f.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 AND p.created_at < ?
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
    } else {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN freshs f ON f.post_id = p.id AND f.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();
    const posts = result.results || [];

    // All posts fetched here are by definition freshed by the current user
    posts.forEach((post: Record<string, unknown>) => {
      post.is_freshed = true;
    });

    // Enrich bookmark state for these posts
    if (posts.length > 0) {
      const postIds = posts.map((p: Record<string, unknown>) => p.id);
      const bmResult = await c.env.DB.prepare(
        `SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
      )
        .bind(userId, ...postIds)
        .all<{ post_id: string }>();
      const bookmarked = new Set((bmResult.results || []).map((r) => r.post_id));
      posts.forEach((post: Record<string, unknown>) => {
        post.is_bookmarked = bookmarked.has(post.id as string);
      });
    }

    await enrichPostsWithReactions(posts as PostRow[], c.env.DB, userId);

    const nextCursor = posts.length === limit ? posts[posts.length - 1].created_at : null;

    return c.json({ posts, nextCursor });
  } catch (error: unknown) {
    console.error('Freshs fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /api/posts/fresh/batch - batch toggle Fresh! for multiple posts (protected)
app.post('/api/posts/fresh/batch', requireAuth, async (c) => {
  try {
    const { post_ids, action } = await c.req.json();

    if (!Array.isArray(post_ids) || post_ids.length === 0) {
      return c.json({ error: 'Invalid post_ids array' }, 400);
    }

    if (!['add', 'remove'].includes(action)) {
      return c.json({ error: 'Invalid action. Must be "add" or "remove"' }, 400);
    }

    const userId = c.get('user')?.id || '';
    const maxBatchSize = 50;

    if (post_ids.length > maxBatchSize) {
      return c.json({ error: `Maximum batch size is ${maxBatchSize}` }, 400);
    }

    // Get posts to check ownership for notifications
    const posts = await c.env.DB.prepare(`
      SELECT id, user_id FROM posts WHERE id IN (${post_ids.map(() => '?').join(',')}) AND status = 'published'
    `)
      .bind(...post_ids)
      .all();

    const validPostIds = posts.results?.map((p) => p.id) || [];
    const invalidIds = post_ids.filter((id) => !validPostIds.includes(id));

    if (invalidIds.length > 0) {
      return c.json({ error: 'Some posts not found', invalid_ids: invalidIds }, 404);
    }

    if (action === 'add') {
      // Check which posts are already freshed to avoid duplicates
      const existingFreshes = await c.env.DB.prepare(`
        SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${post_ids.map(() => '?').join(',')})
      `)
        .bind(userId, ...post_ids)
        .all();

      const alreadyFreshed = new Set(existingFreshes.results?.map((f) => f.post_id) || []);
      const toFresh = post_ids.filter((id) => !alreadyFreshed.has(id));

      if (toFresh.length > 0) {
        // Batch insert freshs
        const stmts = toFresh.map((id) =>
          c.env.DB.prepare('INSERT INTO freshs (post_id, user_id) VALUES (?, ?)').bind(id, userId),
        );
        await c.env.DB.batch(stmts);

        // Batch update fresh counts
        await c.env.DB.prepare(`
          UPDATE posts SET fresh_count = fresh_count + 1, engagement_hotness = engagement_hotness + 2.0 WHERE id IN (${toFresh.map(() => '?').join(',')})
        `)
          .bind(...toFresh)
          .run();

        // Create notifications for non-self posts (grouped)
        const nonSelfPosts = posts.results.filter((p) => toFresh.includes(p.id) && p.user_id !== userId);

        if (nonSelfPosts.length > 0) {
          try {
            // Get existing fresh notifications for these posts
            const userPostPairs = nonSelfPosts.map((p) => ({ userId: p.user_id, postId: p.id }));
            const existingNotifs = await c.env.DB.prepare(`
              SELECT id, user_id, post_id, actor_id, actor_data FROM notifications 
              WHERE (user_id, post_id) IN (${userPostPairs.map(() => '(?, ?)').join(',')}) AND type = 'fresh'
            `)
              .bind(...userPostPairs.flatMap((p) => [p.userId, p.postId]))
              .all();

            const existingMap = new Map<string, Record<string, unknown>>();
            for (const row of existingNotifs.results || []) {
              existingMap.set(`${row.user_id}:${row.post_id}`, row);
            }

            const inserts: Array<[string, string, string, string, string]> = [];
            const updates: Array<{ stmt: ReturnType<typeof c.env.DB.prepare>; params: unknown[] }> = [];

            for (const p of nonSelfPosts) {
              const key = `${p.user_id}:${p.id}`;
              const existing = existingMap.get(key);

              if (existing) {
                const actorData = existing.actor_data
                  ? JSON.parse(existing.actor_data as string)
                  : existing.actor_id
                    ? [existing.actor_id as string]
                    : [];
                if (!actorData.includes(userId)) {
                  actorData.push(userId);
                }
                updates.push({
                  stmt: c.env.DB.prepare(
                    "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
                  ),
                  params: [actorData[0], JSON.stringify(actorData), existing.id as string],
                });
              } else {
                inserts.push([nanoid(), String(p.user_id), 'fresh', String(p.id), userId]);
              }
            }

            // Batch all notification updates and inserts
            const batchStmts: Array<ReturnType<typeof c.env.DB.prepare>> = [];
            for (const update of updates) {
              batchStmts.push(update.stmt.bind(...update.params));
            }
            if (inserts.length > 0) {
              for (const row of inserts) {
                batchStmts.push(
                  c.env.DB.prepare(
                    'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
                  ).bind(...row),
                );
              }
            }
            if (batchStmts.length > 0) {
              await c.env.DB.batch(batchStmts);
            }
          } catch (e) {
            console.error('Failed to create batch fresh notifications:', e);
          }
        }
      }

      return c.json({ freshed: toFresh, already_freshed: Array.from(alreadyFreshed) });
    } else {
      // Remove freshes
      await c.env.DB.prepare(`
        DELETE FROM freshs WHERE user_id = ? AND post_id IN (${post_ids.map(() => '?').join(',')})
      `)
        .bind(userId, ...post_ids)
        .run();

      // Batch update fresh counts
      await c.env.DB.prepare(`
        UPDATE posts SET fresh_count = fresh_count - 1, engagement_hotness = engagement_hotness - 2.0 WHERE id IN (${post_ids.map(() => '?').join(',')})
      `)
        .bind(...post_ids)
        .run();

      return c.json({ unfreshed: post_ids });
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Batch fresh error:', error);
    return c.json({ error: 'Batch fresh operation failed', details: err.message }, 500);
  }
});

// POST /api/posts/:id/share - toggle share/repost (protected)
app.post('/api/posts/:id/share', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id');
    const currentUser = c.get('user');
    if (!currentUser) return c.json({ error: 'Unauthorized' }, 401);

    // Get post info
    const post = (await c.env.DB.prepare(
      "SELECT id, user_id, actor_id, username FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first()) as { id: string; user_id: string; actor_id: string | null; username: string } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    // Check if already shared
    const existing = await c.env.DB.prepare('SELECT id FROM shares WHERE post_id = ? AND user_id = ?')
      .bind(postId, currentUser.id)
      .first();

    if (existing) {
      // Remove share
      await c.env.DB.prepare('DELETE FROM shares WHERE post_id = ? AND user_id = ?').bind(postId, currentUser.id).run();

      await c.env.DB.prepare(
        'UPDATE posts SET reply_count = MAX(0, reply_count - 1), engagement_hotness = MAX(0.0, engagement_hotness - 3.0) WHERE id = ?',
      )
        .bind(postId)
        .run();

      return c.json({ shared: false });
    } else {
      // Add share
      const shareId = nanoid();
      await c.env.DB.prepare(
        "INSERT INTO shares (id, post_id, user_id, actor_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
        .bind(shareId, postId, currentUser.id, `${c.env.BASE_URL}/actors/${currentUser.username}`)
        .run();

      await c.env.DB.prepare(
        'UPDATE posts SET reply_count = reply_count + 1, engagement_hotness = engagement_hotness + 3.0 WHERE id = ?',
      )
        .bind(postId)
        .run();

      // Send Announce for remote posts
      if (post.actor_id && c.env.AP_DELIVERY_QUEUE) {
        try {
          const actorResponse = await fetch(post.actor_id, {
            headers: { Accept: 'application/activity+json, application/ld+json' },
          });
          if (actorResponse.ok) {
            const actorData = (await actorResponse.json()) as ActorData;
            const inboxUrl = actorData.inbox;
            if (inboxUrl) {
              const announceActivity = {
                '@context': 'https://www.w3.org/ns/activitystreams',
                id: `${c.env.BASE_URL}/activities/announce-${shareId}`,
                type: 'Announce',
                actor: `${c.env.BASE_URL}/actors/${currentUser.username}`,
                object: `${c.env.BASE_URL}/notes/${postId}`,
                to: [post.actor_id, 'https://www.w3.org/ns/activitystreams#Public'],
              };
              await c.env.AP_DELIVERY_QUEUE.send({
                type: 'delivery',
                inboxUrl,
                activity: announceActivity,
                senderUsername: currentUser.username,
              });
            }
          }
        } catch (e) {
          console.error('Failed to send Announce activity:', e);
        }
      }

      return c.json({ shared: true, share_id: shareId });
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Share error:', error);
    return c.json({ error: 'Share operation failed', details: err.message }, 500);
  }
});

// GET /api/posts/:id/replies - get direct replies
app.get('/api/posts/:id/replies', async (c) => {
  try {
    const postId = c.req.param('id');
    const cursor = c.req.query('cursor');
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);

    // Get current user ID from session (optional)
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    const currentUserId = sessionData?.user?.id || null;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Verify parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first();

    if (!parentPost) {
      return c.json({ error: 'Post not found' }, 404);
    }

    let query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.parent_id = ? AND p.status = 'published' 
       ORDER BY p.created_at ASC LIMIT ?`;
    const params: Array<unknown> = [postId, limit];

    if (cursor) {
      query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.parent_id = ? AND p.status = 'published' AND p.created_at < ?
       ORDER BY p.created_at ASC LIMIT ?`;
      params.splice(1, 0, cursor);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!result.success) {
      return c.json({ error: 'Failed to fetch replies' }, 500);
    }

    const replies = result.results || [];
    const _nextCursor = replies.length === limit ? replies[replies.length - 1].created_at : null;

    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    // Add poll data
    await enrichPostsWithPolls([parentPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithQuotes([parentPost as PostRow], c.env.DB);
    await enrichPostsWithReactions([parentPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    // Trigger vector embedding for unprocessed posts in background
    const allPosts = [parentPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)];
    const toEmbed = allPosts.filter((p) => p.text);
    if (toEmbed.length > 0) {
      const existingRows = await c.env.DB.prepare(
        `SELECT post_id FROM post_embeddings WHERE post_id IN (${toEmbed.map(() => '?').join(',')})`,
      )
        .bind(...toEmbed.map((p) => p.id as string))
        .all<{ post_id: string }>();
      const existingIds = new Set((existingRows.results || []).map((r) => r.post_id));
      for (const p of toEmbed) {
        if (!existingIds.has(p.id as string)) {
          embedPost(
            c.env.DB,
            c.env.CROWD_ORCHESTRATOR_URL,
            c.env.CROWD_API_KEY,
            c.env.BASE_URL,
            p.id as string,
            p.text as string,
          ).catch((e) => console.error('Background embed failed:', e));
        }
      }
    }

    return c.json({ root: parentPost, replies });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Thread fetch error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/posts/:id/thread - get full thread
app.get('/api/posts/:id/thread', async (c) => {
  try {
    const postId = c.req.param('id');

    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token, c.env.CACHE) : null;
    const currentUserId = sessionData?.user?.id || null;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first();

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const rootId = (post as Record<string, unknown>).root_id || (post as Record<string, unknown>).id;

    const rootPost = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.id = ? AND p.status = 'published'`,
    )
      .bind(rootId)
      .first();

    if (!rootPost) {
      return c.json({ error: 'Thread not found' }, 404);
    }

    const repliesResult = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.root_id = ? AND p.status = 'published' AND p.id != ?
       ORDER BY p.created_at ASC LIMIT 200`,
    )
      .bind(rootId, rootId)
      .all();

    if (!repliesResult.success) {
      return c.json({ error: 'Failed to fetch thread' }, 500);
    }

    const replies = repliesResult.results || [];

    if (currentUserId) {
      const allPosts: Array<Record<string, unknown>> = [
        rootPost as Record<string, unknown>,
        ...(replies as Array<Record<string, unknown>>),
      ];
      const postIds = allPosts.map((p: Record<string, unknown>) => p.id as string);

      const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
      (rootPost as Record<string, unknown>).is_freshed = freshed.has(
        (rootPost as Record<string, unknown>).id as string,
      );
      (replies as Array<Record<string, unknown>>).forEach((post: Record<string, unknown>) => {
        post.is_freshed = freshed.has(post.id as string);
      });
      (rootPost as Record<string, unknown>).is_bookmarked = bookmarked.has(
        (rootPost as Record<string, unknown>).id as string,
      );
      (replies as Array<Record<string, unknown>>).forEach((post: Record<string, unknown>) => {
        post.is_bookmarked = bookmarked.has(post.id as string);
      });
    }

    await enrichPostsWithPolls([rootPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithQuotes([rootPost as PostRow], c.env.DB);
    await enrichPostsWithReactions([rootPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    const allPosts2 = [rootPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)];
    const toEmbed2 = allPosts2.filter((p) => p.text);
    if (toEmbed2.length > 0) {
      const existingRows2 = await c.env.DB.prepare(
        `SELECT post_id FROM post_embeddings WHERE post_id IN (${toEmbed2.map(() => '?').join(',')})`,
      )
        .bind(...toEmbed2.map((p) => p.id as string))
        .all<{ post_id: string }>();
      const existingIds2 = new Set((existingRows2.results || []).map((r) => r.post_id));
      for (const p of toEmbed2) {
        if (!existingIds2.has(p.id as string)) {
          embedPost(
            c.env.DB,
            c.env.CROWD_ORCHESTRATOR_URL,
            c.env.CROWD_API_KEY,
            c.env.BASE_URL,
            p.id as string,
            p.text as string,
          ).catch((e) => console.error('Background embed failed:', e));
        }
      }
    }

    return c.json({ root: rootPost, replies });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Thread fetch error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// Step 1 — POST /api/posts/:id/replies/prepare (protected)
app.post('/api/posts/:id/replies/prepare', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id');
    const { filename, contentType } = await c.req.json();

    if (!filename || !contentType) {
      return c.json({ error: 'Missing filename or contentType' }, 400);
    }

    const allowedTypes = [
      'image/gif',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/mp4',
      'audio/webm',
    ];
    if (!allowedTypes.includes(contentType)) {
      return c.json(
        { error: 'Only image files (GIF, PNG, JPG) and audio files (MP3, WAV, OGG, M4A, WebM) are supported' },
        400,
      );
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first();

    if (!parentPost) {
      return c.json({ error: 'Parent post not found' }, 404);
    }

    const replyId = crypto.randomUUID();
    let fileExtension: string;
    let storageKey: string;

    if (contentType.startsWith('image/')) {
      fileExtension =
        contentType === 'image/png'
          ? '.png'
          : contentType === 'image/jpeg' || contentType === 'image/jpg'
            ? '.jpg'
            : '.gif';
      storageKey = `gif/${replyId}${fileExtension}`;
    } else if (contentType.startsWith('audio/')) {
      fileExtension =
        contentType === 'audio/mpeg'
          ? '.mp3'
          : contentType === 'audio/wav'
            ? '.wav'
            : contentType === 'audio/ogg'
              ? '.ogg'
              : contentType === 'audio/mp4'
                ? '.m4a'
                : '.webm';
      storageKey = `audio/${replyId}${fileExtension}`;
    } else {
      return c.json({ error: 'Unsupported file type' }, 400);
    }

    const gifKey = storageKey;

    // Compute depth and root_id
    const depth = Math.min(Number(parentPost.depth || 0) + 1, 5);
    const rootId = parentPost.root_id || parentPost.id;

    // Store pending reply in D1
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, engagement_hotness, status, parent_id, root_id, depth, reply_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'pending', ?, ?, ?, 0)
    `)
      .bind(
        replyId,
        c.get('user')?.id || '',
        c.get('user')?.username || 'anonymous',
        '',
        '[]',
        '[]',
        gifKey,
        '',
        '',
        postId,
        rootId,
        depth,
      )
      .run();

    if (!result.success) {
      return c.json({ error: 'Failed to create pending reply' }, 500);
    }

    // Generate upload endpoint URL (our own API)
    const gifUploadUrl = `${new URL(c.req.url).origin}/api/upload/${gifKey}`;

    return c.json({
      replyId,
      gifUploadUrl,
      gifKey,
    });
  } catch (error: unknown) {
    console.error('Prepare reply error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Step 3 — POST /api/posts/:id/replies/commit (protected)
app.post('/api/posts/:id/replies/commit', requireAuth, async (c) => {
  const postId = c.req.param('id');

  try {
    const { replyId, gifKey, text, hashtags } = await c.req.json();

    // Validate text
    if (!text || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422);
    }

    // Validate hashtags
    if (!Array.isArray(hashtags) || hashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422);
    }

    for (const tag of hashtags) {
      if (
        typeof tag !== 'string' ||
        tag.length > 20 ||
        !/^[a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(tag)
      ) {
        return c.json({ error: 'Hashtags must be alphanumeric, Japanese characters, and ≤20 chars' }, 422);
      }
    }

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
    const mentionSet = new Set<string>();
    let mentionMatch: RegExpExecArray | null;
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1]);
    }
    const mentionedUsernames = Array.from(mentionSet);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate parent still exists and is published
    const parentPost = (await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published'",
    )
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      username: string;
      text: string;
      depth: number;
      root_id: string | null;
    } | null;

    if (!parentPost) {
      return c.json({ error: 'Parent post no longer available' }, 422);
    }

    let reply: Record<string, unknown> | undefined;
    let mentionsJson: string | null = '[]';

    if (gifKey) {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous';
      mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, replyUsername);

      // Validate that this is a pending reply and gifKey matches
      const pendingReply = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ? AND status = 'pending' AND gif_key = ? AND parent_id = ?
      `)
        .bind(replyId, gifKey, postId)
        .first();

      if (!pendingReply) {
        return c.json({ error: 'Invalid or expired reply preparation' }, 422);
      }

      // Check if GIF exists in R2 (simplified check for now)
      const gifExists = true; // Placeholder - implement actual R2 check

      if (!gifExists) {
        return c.json({ error: 'GIF not uploaded' }, 422);
      }

      // Update reply to published status
      const updateResult = await c.env.DB.prepare(`
        UPDATE posts 
        SET text = ?, hashtags = ?, mentions = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `)
        .bind(text, JSON.stringify(hashtags), mentionsJson, replyId)
        .run();

      if (!updateResult.success) {
        return c.json({ error: 'Failed to commit reply' }, 500);
      }

      // Return the updated reply
      reply =
        (await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.hidden, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
      `)
          .bind(replyId)
          .first()) ?? undefined;
    } else {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous';
      mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, replyUsername);

      // Create text-only reply directly
      const depth = Math.min(Number(parentPost.depth || 0) + 1, 5);
      const rootId = parentPost.root_id || parentPost.id;

      try {
        const result = await c.env.DB.prepare(`
          INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, engagement_hotness, status, parent_id, root_id, depth, reply_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'published', ?, ?, ?, 0)
        `)
          .bind(
            replyId,
            c.get('user')?.id || '',
            replyUsername,
            text,
            JSON.stringify(hashtags),
            mentionsJson,
            '',
            '',
            '',
            postId,
            rootId,
            depth,
          )
          .run();

        if (!result.success) {
          console.error('Failed to create reply:', result.error);
          return c.json({ error: 'Failed to create reply' }, 500);
        }

        // Return the created reply
        reply =
          (await c.env.DB.prepare(`
          SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.hidden, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
        `)
            .bind(replyId)
            .first()) ?? undefined;
      } catch (dbError: unknown) {
        const err = dbError as { message?: string; stack?: string; cause?: unknown; name?: string };
        console.error('Database error creating reply:', dbError);
        console.error('Error details:', {
          message: err.message,
          stack: err.stack,
          cause: err.cause,
          name: err.name,
        });
        return c.json({ error: 'Database error', details: err.message || 'Unknown error' }, 500);
      }
    }

    // Increment parent's reply count and engagement hotness
    const incrementResult = await c.env.DB.prepare(`
      UPDATE posts SET reply_count = COALESCE(reply_count, 0) + 1, engagement_hotness = COALESCE(engagement_hotness, 1.0) + 3.0 WHERE id = ?
    `)
      .bind(postId)
      .run();

    if (!incrementResult.success) {
      console.error('Failed to increment reply count for post:', postId);
      // Don't fail the whole operation, just log the error
    }

    // Create notification for the parent post author (if not replying to own post)
    const notifiedUserIds = new Set<string>();
    const replyUserId = c.get('user')?.id || '';
    if (parentPost.user_id !== replyUserId) {
      try {
        // Group reply notifications: check for existing reply notification for this post
        const existingNotif = (await c.env.DB.prepare(
          "SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = 'reply' ORDER BY created_at DESC LIMIT 1",
        )
          .bind(parentPost.user_id, postId)
          .first()) as Record<string, unknown>;

        if (existingNotif) {
          const actorData = existingNotif.actor_data
            ? JSON.parse(existingNotif.actor_data as string)
            : existingNotif.actor_id
              ? [existingNotif.actor_id as string]
              : [];
          if (!actorData.includes(replyUserId)) {
            actorData.push(replyUserId);
          }
          await c.env.DB.prepare(
            "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
          )
            .bind(actorData[0], JSON.stringify(actorData), existingNotif.id as string)
            .run();
        } else {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          )
            .bind(nanoid(), parentPost.user_id, 'reply', postId, replyUserId)
            .run();
          // Send push notification to parent post author
          {
            const actor = c.get('user');

            await sendPushToAll(c.env, parentPost.user_id, 'reply', actor?.username, actor?.display_name, text, postId);
          }
        }
        notifiedUserIds.add(parentPost.user_id);
      } catch (e) {
        console.error('Failed to create reply notification:', e);
        // Don't fail the whole operation, just log the error
      }
    }

    // Create mention notifications for mentioned users in the reply (skip self-mentions)
    if (mentionedUsernames.length > 0) {
      try {
        const mentionData = JSON.parse(mentionsJson) as Array<{ username: string; user_id: string }>;
        const mentionStmts = mentionData
          .filter((m) => m.user_id !== replyUserId)
          .map((m) =>
            c.env.DB.prepare(
              'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
            ).bind(nanoid(), m.user_id, 'mention', replyId, replyUserId),
          );
        if (mentionStmts.length > 0) {
          await c.env.DB.batch(mentionStmts);
        }
        for (const mention of mentionData) {
          if (mention.user_id === replyUserId) continue;
          const actor = c.get('user');
          await sendPushToAll(c.env, mention.user_id, 'mention', actor?.username, actor?.display_name, text, postId);
        }
      } catch (e) {
        // Don't fail the reply creation if mention notifications fail
        console.error('Failed to create mention notifications:', e);
      }
    }

    // Create notifications for >>N post references in the reply
    // Skip if the referenced post author was already notified (e.g., parent post author)
    try {
      const refRegex = />>(\d+)/g;
      const referencedIndices = new Set<number>();
      let refMatch: RegExpExecArray | null;
      while ((refMatch = refRegex.exec(text)) !== null) {
        const index = parseInt(refMatch[1], 10);
        if (index > 0) referencedIndices.add(index);
      }

      if (referencedIndices.size > 0) {
        const rootId = parentPost.root_id || parentPost.id;
        const allRepliesResult = await c.env.DB.prepare(
          "SELECT id, user_id, username FROM posts WHERE root_id = ? AND status = 'published' AND id != ? ORDER BY created_at ASC",
        )
          .bind(rootId, rootId)
          .all();

        const allReplies = allRepliesResult.results || [];

        const refUpdateStmts: D1PreparedStatement[] = [];
        const refNotifyStmts: D1PreparedStatement[] = [];
        const refNotifyTargets: Array<{ userId: string; user_id: string }> = [];
        for (const refIndex of referencedIndices) {
          const arrayIndex = refIndex - 1;
          if (arrayIndex >= 0 && arrayIndex < allReplies.length) {
            const referencedPost = allReplies[arrayIndex] as Record<string, unknown>;
            if (referencedPost.id !== postId) {
              refUpdateStmts.push(
                c.env.DB.prepare(
                  'UPDATE posts SET reply_count = COALESCE(reply_count, 0) + 1, engagement_hotness = COALESCE(engagement_hotness, 1.0) + 3.0 WHERE id = ?',
                ).bind(referencedPost.id as string),
              );
            }
            if (
              referencedPost.user_id &&
              (referencedPost.user_id as string) !== replyUserId &&
              !notifiedUserIds.has(referencedPost.user_id as string)
            ) {
              refNotifyStmts.push(
                c.env.DB.prepare(
                  'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
                ).bind(nanoid(), referencedPost.user_id as string, 'reply', replyId, replyUserId),
              );
              refNotifyTargets.push({
                userId: referencedPost.user_id as string,
                user_id: referencedPost.user_id as string,
              });
            }
          }
        }
        const allRefStmts = [...refUpdateStmts, ...refNotifyStmts];
        if (allRefStmts.length > 0) {
          await c.env.DB.batch(allRefStmts);
        }
        for (const target of refNotifyTargets) {
          const actor = c.get('user');
          await sendPushToAll(c.env, target.userId, 'reply', actor?.username, actor?.display_name, text || '', replyId);
        }
      }
    } catch (e) {
      console.error('Failed to create >>N reference notifications:', e);
    }

    if (gifKey) {
      submitDetectNsfw(c.env.DB, c.env.CROWD_ORCHESTRATOR_URL, c.env.CROWD_API_KEY, c.env.BASE_URL, replyId, gifKey);
    }

    return c.json({ reply });
  } catch (error: unknown) {
    const err = error as { message?: string; stack?: string; cause?: unknown; name?: string; replyId?: string };
    console.error('Commit reply error:', error);
    console.error('Full error details:', {
      message: err.message,
      stack: err.stack,
      cause: err.cause,
      name: err.name,
      postId: postId || 'unknown',
      replyId: err.replyId || 'unknown',
    });
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/search - search posts and users
app.get('/api/search', async (c) => {
  try {
    const query = c.req.query('q');
    const type = c.req.query('type') || 'posts';
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50);

    if (!query || query.trim().length === 0) {
      return c.json({ error: 'Search query required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Try cache hit
    const cacheKey = makeCacheKey('search', c, `${type}:${limit}:${query.trim().toLowerCase().slice(0, 100)}`);
    const cached = await kvCacheGet<{
      type: string;
      query: string;
      results: Record<string, unknown>[];
      users: Record<string, unknown>[];
    }>(c, cacheKey);
    if (cached) {
      return c.json(cached);
    }

    const tokens = query.trim().split(/\s+/).filter(Boolean);

    if (type === 'users') {
      const cleanQuery = query.trim().replace(/^@/, '');
      const searchTerm = `%${cleanQuery}%`;
      const users = await c.env.DB.prepare(`
        SELECT id, username, display_name, bio, avatar_key, created_at
        FROM users
        WHERE username LIKE ? OR display_name LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
        .bind(searchTerm, searchTerm, limit)
        .all();

      return c.json({
        type: 'users',
        query,
        results: users.results || [],
      });
    }

    // Build multi-term AND search for posts / arcade
    const conditions: string[] = [];
    const params: Array<unknown> = [];

    if (type === 'arcade') {
      conditions.push("(p.payload_key IS NOT NULL AND p.payload_key != '' AND (p.swf_key IS NULL OR p.swf_key = ''))");
    }

    for (const token of tokens) {
      if (token.startsWith('#')) {
        const tag = token.slice(1).trim();
        if (tag) {
          conditions.push(`EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?)`);
          params.push(tag);
        }
      } else {
        conditions.push('LOWER(p.text) LIKE ?');
        params.push(`%${token.toLowerCase()}%`);
      }
    }

    const cleanQuery = query.trim().replace(/^@/, '');
    const searchTerm = `%${cleanQuery.toLowerCase()}%`;

    let usersResult: Array<Record<string, unknown>> = [];

    if (conditions.length === 0) {
      // No specific tokens, but still search users by the raw query
      if (type === 'posts') {
        const users = await c.env.DB.prepare(`
          SELECT username, display_name, avatar_key
          FROM users
          WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
          ORDER BY created_at DESC LIMIT ?
        `)
          .bind(searchTerm, searchTerm, limit)
          .all();
        usersResult = (users.results || []).map((u: Record<string, unknown>) => ({
          username: u.username,
          display_name: u.display_name || '',
          avatar_key: u.avatar_key || '',
        }));
      }
      return c.json({ type, query, results: [], users: usersResult });
    }

    const whereClause = `WHERE p.status = 'published' AND p.hidden = 0 AND (${conditions.join(' AND ')})`;

    const selectColumns = `
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
    `;

    const posts = await c.env.DB.prepare(`${selectColumns} ${whereClause} ORDER BY p.created_at DESC LIMIT ?`)
      .bind(...params, limit)
      .all();

    await enrichPostsWithQuotes((posts.results || []) as PostRow[], c.env.DB);
    await enrichPostsWithReactions((posts.results || []) as PostRow[], c.env.DB, c.get('user')?.id);

    // Also fetch matching users for posts search (type=posts)
    if (type === 'posts') {
      const users = await c.env.DB.prepare(`
        SELECT username, display_name, avatar_key
        FROM users
        WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
        ORDER BY created_at DESC LIMIT ?
      `)
        .bind(searchTerm, searchTerm, limit)
        .all();
      usersResult = (users.results || []).map((u: Record<string, unknown>) => ({
        username: u.username,
        display_name: u.display_name || '',
        avatar_key: u.avatar_key || '',
      }));
    }

    const responseData = {
      type,
      query,
      results: posts.results || [],
      users: usersResult,
    };
    await kvCacheSet(c, cacheKey, responseData, 30);
    return c.json(responseData);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Search error:', error);
    return c.json({ error: 'Search failed', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/posts/:id - delete post (protected)
app.delete('/api/posts/:id', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id');
    const userId = c.get('user')?.id || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get the post to verify ownership and get file keys
    const post = (await c.env.DB.prepare(
      'SELECT id, user_id, username, parent_id, gif_key, payload_key, swf_key, thumbnail_key, status FROM posts WHERE id = ?',
    )
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      username: string;
      parent_id?: string;
      gif_key?: string;
      payload_key?: string;
      swf_key?: string;
      thumbnail_key?: string;
      status?: string;
    } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    // Verify ownership
    if (post.user_id !== userId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Delete associated files from R2
    if (c.env.BUCKET) {
      if (post.gif_key) {
        try {
          await c.env.BUCKET.delete(post.gif_key);
        } catch (e) {
          console.error('Failed to delete gif file:', e);
        }
      }
      if (post.payload_key) {
        try {
          await c.env.BUCKET.delete(post.payload_key);
        } catch (e) {
          console.error('Failed to delete payload file:', e);
        }
      }
      if (post.swf_key) {
        try {
          await c.env.BUCKET.delete(post.swf_key);
        } catch (e) {
          console.error('Failed to delete SWF file:', e);
        }
      }
      if (post.thumbnail_key) {
        try {
          await c.env.BUCKET.delete(post.thumbnail_key);
        } catch (e) {
          console.error('Failed to delete thumbnail file:', e);
        }
      }
    }

    // Delete all replies (and their replies) to this post using recursive CTE
    const descendantResult = await c.env.DB.prepare(`
      WITH RECURSIVE tree AS (
        SELECT id, gif_key, payload_key, swf_key, thumbnail_key FROM posts WHERE parent_id = ?
        UNION ALL
        SELECT p.id, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key FROM posts p INNER JOIN tree t ON p.parent_id = t.id
      )
      SELECT id, gif_key, payload_key, swf_key, thumbnail_key FROM tree
    `)
      .bind(postId)
      .all<{
        id: string;
        gif_key: string | null;
        payload_key: string | null;
        swf_key: string | null;
        thumbnail_key: string | null;
      }>();
    const descendants = descendantResult.results || [];

    // Delete descendant reply files from R2
    if (c.env.BUCKET) {
      for (const desc of descendants) {
        if (desc.gif_key) {
          try {
            await c.env.BUCKET.delete(desc.gif_key);
          } catch (e) {
            console.error('Failed to delete descendant gif file:', e);
          }
        }
        if (desc.payload_key) {
          try {
            await c.env.BUCKET.delete(desc.payload_key);
          } catch (e) {
            console.error('Failed to delete descendant payload file:', e);
          }
        }
        if (desc.swf_key) {
          try {
            await c.env.BUCKET.delete(desc.swf_key);
          } catch (e) {
            console.error('Failed to delete descendant SWF file:', e);
          }
        }
        if (desc.thumbnail_key) {
          try {
            await c.env.BUCKET.delete(desc.thumbnail_key);
          } catch (e) {
            console.error('Failed to delete descendant thumbnail file:', e);
          }
        }
      }
    }

    const descendantIds = descendants.map((r) => r.id);
    if (descendantIds.length > 0) {
      const placeholders = descendantIds.map(() => '?').join(',');
      await c.env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`)
        .bind(...descendantIds)
        .run();
    }

    // Delete the post
    const result = await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();

    if (!result.success) {
      return c.json({ error: 'Failed to delete post' }, 500);
    }

    // Decrement parent's reply count and engagement hotness if this post was a reply
    if (post.parent_id) {
      await c.env.DB.prepare(
        'UPDATE posts SET reply_count = COALESCE(reply_count, 0) - 1, engagement_hotness = GREATEST(COALESCE(engagement_hotness, 1.0) - 3.0, 0.0) WHERE id = ?',
      )
        .bind(post.parent_id)
        .run();
    }

    // Queue ActivityPub delete delivery for public posts
    if (post && post.status === 'published') {
      try {
        const user = c.get('user');
        if (user) {
          const noteId = `${c.env.BASE_URL}/notes/${postId}`;
          const activity = buildDeleteActivity(noteId, user, c.env.BASE_URL);

          // Get all followers to deliver to
          const followers = await c.env.DB.prepare(`
            SELECT inbox_url FROM ap_followers WHERE local_user_id = ?
          `)
            .bind(user.id)
            .all();

          // Queue delivery to each follower
          for (const follower of followers.results) {
            const inboxUrl = follower.inbox_url;
            if (inboxUrl) {
              await c.env.AP_DELIVERY_QUEUE.send({
                type: 'delivery',
                inboxUrl,
                activity,
                senderUsername: user.username,
              });
            }
          }
        }
      } catch (deliveryError) {
        console.error('Failed to queue ActivityPub delete delivery:', deliveryError);
        // Don't fail the post deletion if delivery queuing fails
      }
    }

    // Invalidate cache entries related to the deleted post
    if (c.env.CACHE) {
      try {
        // Delete games cache entries (since deleted posts might be games)
        await c.env.CACHE.delete('games:recent:20:first');
        await c.env.CACHE.delete('games:trending:20:first');

        // Delete any other cache keys that might contain this post
        // Pattern: games:{trending|recent}:{limit}:{cursor}
        // We'll delete the most common ones
        const cacheKeysToDelete = [
          'games:recent:20:first',
          'games:trending:20:first',
          'games:recent:50:first',
          'games:trending:50:first',
        ];

        for (const key of cacheKeysToDelete) {
          await c.env.CACHE.delete(key);
        }

        console.log('Cache invalidated for deleted post:', postId);
      } catch (cacheError) {
        console.warn('Failed to invalidate cache for deleted post:', cacheError);
        // Don't fail the deletion if cache invalidation fails
      }
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Delete post error:', error);
    return c.json({ error: 'Failed to delete post', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/posts/:id - edit post (protected)
app.put('/api/posts/:id', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const userId = user.id;
    const postId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, mentions, status, gif_key, payload_key, swf_key, thumbnail_key, edited_at FROM posts WHERE id = ?',
    )
      .bind(postId)
      .first<{
        id: string;
        user_id: string;
        username: string;
        text: string;
        hashtags: string | null;
        mentions: string | null;
        status: string;
        gif_key: string | null;
        payload_key: string | null;
        swf_key: string | null;
        thumbnail_key: string | null;
        edited_at: string | null;
      } | null>();

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    if (post.user_id !== userId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (post.status !== 'published') {
      return c.json({ error: 'Cannot edit this post' }, 400);
    }

    const body = (await c.req.json()) as {
      text?: string;
      gif_key?: string | null;
      payload_key?: string | null;
      swf_key?: string | null;
      thumbnail_key?: string | null;
    };

    const now = new Date().toISOString();
    let trimmed = post.text;
    let hashtagsJson = post.hashtags;
    let mentionsJson = post.mentions;
    let textChanged = false;

    // Update text if provided
    if (body.text !== undefined && typeof body.text === 'string') {
      trimmed = body.text.trim();
      if (trimmed.length < 1 || trimmed.length > 200) {
        return c.json({ error: 'Text must be between 1 and 200 characters' }, 422);
      }
      textChanged = true;

      // Extract hashtags from text
      const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
      const hashtagSet = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = hashtagRegex.exec(trimmed)) !== null) {
        hashtagSet.add(match[1]);
      }
      const hashtags = Array.from(hashtagSet);
      if (hashtags.length > 5) {
        return c.json({ error: 'Maximum 5 hashtags allowed' }, 422);
      }
      hashtagsJson = JSON.stringify(hashtags);

      // Extract mentions from text
      const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
      const mentionSet = new Set<string>();
      let mentionMatch: RegExpExecArray | null;
      while ((mentionMatch = mentionRegex.exec(trimmed)) !== null) {
        mentionSet.add(mentionMatch[1]);
      }
      const mentionedUsernames = Array.from(mentionSet);
      mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, post.username);
    }

    // Handle attachment key updates and cleanup old files
    const updatedGifKey = body.gif_key !== undefined ? body.gif_key : post.gif_key;
    const updatedPayloadKey = body.payload_key !== undefined ? body.payload_key : post.payload_key;
    const updatedSwfKey = body.swf_key !== undefined ? body.swf_key : post.swf_key;
    const updatedThumbnailKey = body.thumbnail_key !== undefined ? body.thumbnail_key : post.thumbnail_key;

    // Delete old files from R2 when keys change
    const keysToDelete: string[] = [];
    if (body.gif_key !== undefined && post.gif_key && post.gif_key !== body.gif_key) {
      keysToDelete.push(post.gif_key);
    }
    if (body.payload_key !== undefined && post.payload_key && post.payload_key !== body.payload_key) {
      keysToDelete.push(post.payload_key);
    }
    if (body.swf_key !== undefined && post.swf_key && post.swf_key !== body.swf_key) {
      keysToDelete.push(post.swf_key);
    }
    if (body.thumbnail_key !== undefined && post.thumbnail_key && post.thumbnail_key !== body.thumbnail_key) {
      keysToDelete.push(post.thumbnail_key);
    }

    if (keysToDelete.length > 0 && c.env.BUCKET) {
      Promise.all(keysToDelete.map((k) => c.env.BUCKET.delete(k).catch(() => {}))).catch(() => {});
    }

    await c.env.DB.prepare(
      'UPDATE posts SET text = ?, hashtags = ?, mentions = ?, gif_key = ?, payload_key = ?, swf_key = ?, thumbnail_key = ?, edited_at = ? WHERE id = ?',
    )
      .bind(
        trimmed,
        hashtagsJson || '[]',
        mentionsJson || '[]',
        updatedGifKey || null,
        updatedPayloadKey || null,
        updatedSwfKey || null,
        updatedThumbnailKey || null,
        textChanged || keysToDelete.length > 0 ? now : post.edited_at || null,
        postId,
      )
      .run();

    // Fetch updated post
    const updated = (await c.env.DB.prepare(
      "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key as payloadKey, p.swf_key as swfKey, p.thumbnail_key as thumbnailKey, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.edited_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?",
    )
      .bind(postId)
      .first()) as Record<string, unknown> | null;

    return c.json({ post: updated });
  } catch (error: unknown) {
    const err = error as { message?: string; stack?: string };
    console.error('Edit post error:', error);
    return c.json({ error: 'Failed to edit post', details: err.message || String(error), stack: err.stack }, 500);
  }
});

// GET /api/posts/:id - get single post
app.get('/api/posts/:id', async (c) => {
  try {
    const postId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = (await c.env.DB.prepare(
      'SELECT p.*, u.language as author_language FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?',
    )
      .bind(postId)
      .first()) as Record<string, unknown> | null;

    if (!post) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Auto-restore if counter-notification period has passed
    if (post.hidden) {
      await autoRestoreIfEligible(c.env.DB, postId);
      // Re-fetch after potential restore
      const refreshed = (await c.env.DB.prepare('SELECT hidden FROM posts WHERE id = ?').bind(postId).first()) as {
        hidden: number;
      } | null;
      if (refreshed) post.hidden = refreshed.hidden;
    }

    // Check if post is hidden - allow admin bypass
    if (post.hidden && !isAdmin(c.env, c.get('user')?.username ?? '')) {
      return c.json({ error: 'Gone' }, 410);
    }

    // Fetch poll data if available
    const poll = (await c.env.DB.prepare('SELECT * FROM polls WHERE post_id = ?').bind(postId).first()) as Record<
      string,
      unknown
    > | null;
    if (poll) {
      const { results: options } = await c.env.DB.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY rowid')
        .bind(poll.id as string)
        .all();
      let userVote: string | null = null;
      const currentUserId = c.get('user')?.id;
      if (currentUserId) {
        const vote = (await c.env.DB.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?')
          .bind(poll.id as string, currentUserId)
          .first()) as { option_id: string } | null;
        if (vote) userVote = vote.option_id;
      }
      post.poll = {
        id: poll.id as string,
        question: poll.question as string,
        multipleChoice: !!poll.multiple_choice,
        endsAt: poll.ends_at as string | undefined,
        options,
        userVote,
      };
    }

    await enrichPostsWithQuotes([post as PostRow], c.env.DB);
    await enrichPostsWithReactions([post as PostRow], c.env.DB, c.get('user')?.id);

    return c.json(post);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Get post error:', error);
    return c.json({ error: 'Failed to get post', details: err.message || 'Unknown error' }, 500);
  }
});

// Helper function to get threshold for a category
function getThreshold(category: ReportCategory): number {
  const thresholds: Record<ReportCategory, number> = {
    spam: 3,
    harassment: 3,
    inappropriate: 3,
    misinformation: 3,
    other: 3,
    hate_speech: 3,
    copyright: 1,
    csam: 1,
    malware: 1,
    privacy: 3,
    nsfw_untagged: 2,
  };
  return thresholds[category];
}

// Helper function to get priority for a category
function getPriority(category: ReportCategory): 'critical' | 'high' | 'normal' {
  if (category === 'csam' || category === 'malware') {
    return 'critical';
  }
  if (category === 'copyright') {
    return 'high';
  }
  return 'normal';
}

// Helper function to resolve mentioned usernames to {username, user_id} objects
async function resolveMentions(db: D1Database, mentionedUsernames: string[], currentUsername: string): Promise<string> {
  if (mentionedUsernames.length === 0) return '[]';
  const placeholders = mentionedUsernames.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, username FROM users WHERE LOWER(username) IN (${placeholders})`)
    .bind(...mentionedUsernames.map((u) => u.toLowerCase()))
    .all<{ id: string; username: string }>();
  const userMap = new Map(rows.results?.map((r) => [r.username.toLowerCase(), r]) || []);
  return JSON.stringify(
    mentionedUsernames
      .map((u) => {
        const user = userMap.get(u.toLowerCase());
        return user ? { username: user.username, user_id: user.id } : null;
      })
      .filter(Boolean),
  );
}

// Helper function to insert notification
async function insertNotification(
  db: D1Database,
  userId: string,
  type: 'fresh' | 'reported' | 'warned' | 'hidden',
  postId: string,
  actorId?: string,
) {
  const _messages: Record<string, string> = {
    fresh: 'fresed your post',
    reported: 'reported your post',
    warned: 'Your post has been reported for {category}. It may be removed if it violates our ToS.',
    hidden: 'Your post has been removed due to a {category} report.',
  };
  await db
    .prepare('INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)')
    .bind(nanoid(), userId, type, postId, actorId || null)
    .run();
}

// Helper function to insert admin alert
async function insertAdminAlert(
  db: D1Database,
  postId: string,
  category: ReportCategory,
  priority: 'critical' | 'high' | 'normal',
) {
  const id = nanoid();
  const result = await db
    .prepare('INSERT INTO admin_alerts (id, post_id, category, priority, status) VALUES (?, ?, ?, ?, ?)')
    .bind(id, postId, category, priority, 'open')
    .run();
  if (!result.success) {
    console.error('Failed to create admin alert');
  }
}

// Check and auto-restore posts where counter-notification period has expired
async function autoRestoreIfEligible(db: D1Database, postId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const result = await db
      .prepare(
        `SELECT id FROM counter_notifications
         WHERE post_id = ? AND status = 'pending' AND restore_at IS NOT NULL AND restore_at <= ?`,
      )
      .bind(postId, now)
      .first();

    if (result) {
      await db.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').bind(postId).run();
      await db
        .prepare("UPDATE counter_notifications SET status = ? WHERE post_id = ? AND status = 'pending'")
        .bind('auto_restored', postId)
        .run();
      console.log(`Auto-restored post ${postId} after counter-notification period`);
    }
  } catch (err) {
    console.error('Auto-restore check failed:', err);
  }
}

async function enrichPostsWithPolls(posts: PostRow[], db: D1Database, currentUserId?: string | null): Promise<void> {
  if (posts.length === 0) return;
  const postIds = posts.map((p) => p.id);
  const placeholders = postIds.map(() => '?').join(',');
  const pollsResult = await db
    .prepare(`SELECT * FROM polls WHERE post_id IN (${placeholders})`)
    .bind(...postIds)
    .all<PollRow>();

  if (!pollsResult.success || pollsResult.results.length === 0) return;

  const pollMap = new Map<string, PollRow>();
  for (const poll of pollsResult.results) {
    pollMap.set(poll.post_id, poll);
  }

  const pollIds = pollsResult.results.map((p: PollRow) => p.id);
  const optPlaceholders = pollIds.map(() => '?').join(',');

  // Parallelize poll options and user votes queries
  const [optsResult, votesResult] = await Promise.all([
    db
      .prepare(`SELECT * FROM poll_options WHERE poll_id IN (${optPlaceholders}) ORDER BY rowid`)
      .bind(...pollIds)
      .all<PollOptionRow>(),
    currentUserId
      ? db
          .prepare(`SELECT poll_id, option_id FROM poll_votes WHERE poll_id IN (${optPlaceholders}) AND user_id = ?`)
          .bind(...pollIds, currentUserId)
          .all<{ poll_id: string; option_id: string }>()
      : Promise.resolve({ success: true, results: [] as Array<{ poll_id: string; option_id: string }> }),
  ]);

  const optsByPoll = new Map<string, PollOptionRow[]>();
  if (optsResult.success) {
    for (const opt of optsResult.results) {
      const pid = opt.poll_id;
      if (!optsByPoll.has(pid)) optsByPoll.set(pid, []);
      optsByPoll.get(pid)!.push(opt);
    }
  }

  const userVotes = new Map<string, string>();
  if (votesResult.success) {
    for (const v of votesResult.results) {
      userVotes.set(v.poll_id, v.option_id);
    }
  }

  for (const post of posts) {
    const poll = pollMap.get(post.id);
    if (poll) {
      const now = new Date();
      const endsAt = poll.ends_at || null;
      const expired = endsAt ? new Date(endsAt) <= now : false;
      post.poll = {
        id: poll.id,
        question: poll.question,
        multipleChoice: !!poll.multiple_choice,
        endsAt,
        options: optsByPoll.get(poll.id) || [],
        userVote: userVotes.get(poll.id) || null,
        expired,
      };
    }
  }
}

/**
 * Batch-fetch quoted posts referenced by the given posts and attach them as
 * `quoted_post`. Only embeds 1 level deep (never recurses) to avoid infinite
 * nesting. Deleted/hidden/absent quoted posts are set to null so the client can
 * render a "post unavailable" placeholder.
 */
async function enrichPostsWithQuotes(posts: PostRow[], db: D1Database): Promise<void> {
  if (posts.length === 0) return;

  const postIds = posts.map((p) => p.id);
  const idPlaceholders = postIds.map(() => '?').join(',');
  const linksResult = await db
    .prepare(`SELECT id, quoted_post_id FROM posts WHERE id IN (${idPlaceholders}) AND quoted_post_id IS NOT NULL`)
    .bind(...postIds)
    .all<{ id: string; quoted_post_id: string }>();

  const links = linksResult.results || [];
  const quotedIds = [...new Set(links.map((r) => r.quoted_post_id))];
  const quotedMap = new Map<string, Record<string, unknown>>();

  if (quotedIds.length > 0) {
    const placeholders = quotedIds.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.language as author_language,
              p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key,
              p.thumbnail_key, p.parent_id, p.root_id, COALESCE(p.depth, 0) AS depth,
              COALESCE(p.status, 'published') AS status, p.hidden, p.created_at
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.id IN (${placeholders})`,
      )
      .bind(...quotedIds)
      .all<Record<string, unknown>>();

    for (const quoted of result.results || []) {
      if (quoted.status === 'published' && !quoted.hidden) {
        quotedMap.set(quoted.id as string, quoted);
      }
    }
  }

  for (const post of posts) {
    const link = links.find((r) => r.id === post.id);
    post.quoted_post_id = link?.quoted_post_id ?? null;
    post.quoted_post = link ? quotedMap.get(link.quoted_post_id) || null : null;
  }
}

async function enrichPostsWithReactions(
  posts: PostRow[],
  db: D1Database,
  currentUserId?: string | null,
): Promise<void> {
  if (posts.length === 0) return;

  const postIds = posts.map((p) => p.id);
  const placeholders = postIds.map(() => '?').join(',');

  const summaryResult = await db
    .prepare(
      `SELECT post_id, emoji, COUNT(*) AS count FROM reactions
       WHERE post_id IN (${placeholders})
       GROUP BY post_id, emoji`,
    )
    .bind(...postIds)
    .all<{ post_id: string; emoji: string; count: number }>();

  const mine = new Set<string>();
  if (currentUserId) {
    const mineResult = await db
      .prepare(`SELECT post_id, emoji FROM reactions WHERE user_id = ? AND post_id IN (${placeholders})`)
      .bind(currentUserId, ...postIds)
      .all<{ post_id: string; emoji: string }>();
    for (const r of mineResult.results || []) {
      mine.add(`${r.post_id}:${r.emoji}`);
    }
  }

  // Collect unique custom stamp names used in reactions
  const stampNames = new Set<string>();
  for (const row of summaryResult.results || []) {
    if (/^:.+:$/.test(row.emoji)) {
      stampNames.add(row.emoji);
    }
  }

  // Resolve custom stamp names to image URLs
  const stampUrlMap = new Map<string, string>();
  if (stampNames.size > 0) {
    const stampRows = await db
      .prepare(
        `SELECT name, image_key FROM custom_stamps WHERE name IN (${Array.from(stampNames)
          .map(() => '?')
          .join(',')})`,
      )
      .bind(...stampNames)
      .all<{ name: string; image_key: string }>();
    for (const s of stampRows.results || []) {
      stampUrlMap.set(s.name, `/api/images/${s.image_key}`);
    }
  }

  const grouped = new Map<string, Array<{ emoji: string; count: number; reacted: boolean; stamp_url?: string }>>();
  for (const row of summaryResult.results || []) {
    if (!grouped.has(row.post_id)) grouped.set(row.post_id, []);
    const entry: { emoji: string; count: number; reacted: boolean; stamp_url?: string } = {
      emoji: row.emoji,
      count: row.count,
      reacted: mine.has(`${row.post_id}:${row.emoji}`),
    };
    const stampUrl = stampUrlMap.get(row.emoji);
    if (stampUrl) entry.stamp_url = stampUrl;
    grouped.get(row.post_id)!.push(entry);
  }

  for (const post of posts) {
    post.reactions = grouped.get(post.id) || [];
  }
}

// POST /api/report - unified report endpoint (protected)
app.post('/api/report', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const _username = c.get('user')?.username || '';
    const { post_id, category, dmca } = (await c.req.json()) as {
      post_id: string;
      category: ReportCategory;
      dmca?: {
        work_description: string;
        reporter_email: string;
        sworn: boolean;
      };
    };

    // Validate category
    const validCategories: ReportCategory[] = [
      'spam',
      'harassment',
      'inappropriate',
      'misinformation',
      'other',
      'hate_speech',
      'copyright',
      'csam',
      'malware',
      'privacy',
      'nsfw_untagged',
    ];
    if (!category || !validCategories.includes(category)) {
      return c.json({ error: 'Invalid category' }, 400);
    }

    // DMCA validation
    if (category === 'copyright') {
      if (!dmca) {
        return c.json({ error: 'DMCA information required for copyright reports' }, 400);
      }
      if (!dmca.sworn) {
        return c.json({ error: 'You must swear that this report is made in good faith' }, 400);
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(dmca.reporter_email)) {
        return c.json({ error: 'Invalid email format' }, 400);
      }
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get the post
    const post = (await c.env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ? AND hidden = 0')
      .bind(post_id)
      .first()) as { id: string; user_id: string } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    // Cannot report own post
    if (post.user_id === userId) {
      return c.json({ error: 'Cannot report own post' }, 403);
    }

    // Check for duplicate report
    const existingReport = await c.env.DB.prepare('SELECT id FROM reports WHERE post_id = ? AND user_id = ?')
      .bind(post_id, userId)
      .first();

    if (existingReport) {
      return c.json({ error: 'Already reported' }, 409);
    }

    // Insert report with optional DMCA fields
    const reportId = nanoid();
    if (dmca && category === 'copyright') {
      await c.env.DB.prepare(
        'INSERT INTO reports (id, post_id, user_id, category, dmca_work_description, dmca_reporter_email, dmca_sworn, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          reportId,
          post_id,
          userId,
          category,
          dmca.work_description,
          dmca.reporter_email,
          dmca.sworn ? 1 : 0,
          'pending',
        )
        .run();
    } else {
      await c.env.DB.prepare('INSERT INTO reports (id, post_id, user_id, category, status) VALUES (?, ?, ?, ?, ?)')
        .bind(reportId, post_id, userId, category, 'pending')
        .run();
    }

    // Process based on category
    if (category === 'csam' || category === 'malware') {
      // Immediate hide - no threshold check
      await c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(post_id).run();
      await insertNotification(c.env.DB, post.user_id, 'hidden', post_id);
      await insertAdminAlert(c.env.DB, post_id, category, 'critical');
    } else if (category === 'nsfw_untagged') {
      const threshold = getThreshold(category);
      const { count } = (await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM reports WHERE post_id = ? AND category = ?',
      )
        .bind(post_id, category)
        .first()) as { count: number };

      if (count >= threshold) {
        await c.env.DB.prepare('UPDATE reports SET status = ? WHERE post_id = ?').bind('warned', post_id).run();
        await insertNotification(c.env.DB, post.user_id, 'warned', post_id);

        // Add #nsfw tag to post if not already present (no hiding)
        const postRow = (await c.env.DB.prepare('SELECT hashtags FROM posts WHERE id = ?').bind(post_id).first()) as {
          hashtags: string;
        } | null;

        if (postRow) {
          const hashtags: string[] = JSON.parse(postRow.hashtags);
          if (!hashtags.some((t: string) => t.toLowerCase() === 'nsfw' || t.toLowerCase() === 'r18')) {
            hashtags.push('nsfw');
            await c.env.DB.prepare('UPDATE posts SET hashtags = ? WHERE id = ?')
              .bind(JSON.stringify(hashtags), post_id)
              .run();
          }
        }
      }
    } else {
      const threshold = getThreshold(category);
      const { count } = (await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM reports WHERE post_id = ? AND category = ?',
      )
        .bind(post_id, category)
        .first()) as { count: number };

      if (count >= threshold) {
        await c.env.DB.prepare('UPDATE reports SET status = ? WHERE post_id = ?').bind('warned', post_id).run();
        await insertNotification(c.env.DB, post.user_id, 'warned', post_id);

        // Also hide the post and send hidden notification when threshold is reached
        await c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(post_id).run();
        await insertNotification(c.env.DB, post.user_id, 'hidden', post_id);

        const priority = getPriority(category);
        await insertAdminAlert(c.env.DB, post_id, category, priority);
      }
    }

    return c.json({ success: true, report_id: reportId });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Report error:', error);
    return c.json({ error: 'Failed to report post', details: err.message || 'Unknown error' }, 500);
  }
});

// Helper: add N business days to a date (weekdays only, no holiday calendar)
function addBusinessDays(date: Date, days: number): Date {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

// POST /api/posts/:id/counter-notice - file a DMCA counter-notification (protected)
app.post('/api/posts/:id/counter-notice', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const postId = c.req.param('id') || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }
    if (!postId) {
      return c.json({ error: 'Post ID is required' }, 400);
    }

    const post = (await c.env.DB.prepare('SELECT id, user_id, hidden FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as { id: string; user_id: string; hidden: number } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    if (post.user_id !== userId) {
      return c.json({ error: 'You can only file a counter-notice for your own posts' }, 403);
    }

    if (!post.hidden) {
      return c.json({ error: 'Post is not hidden, no counter-notice needed' }, 400);
    }

    // Check existing counter-notice
    const existing = await c.env.DB.prepare(
      'SELECT id FROM counter_notifications WHERE post_id = ? AND user_id = ? AND status = ?',
    )
      .bind(postId, userId, 'pending')
      .first();

    if (existing) {
      return c.json({ error: 'A pending counter-notice already exists for this post' }, 409);
    }

    const { name, email, address, phone, statement, consent_jurisdiction } = (await c.req.json()) as {
      name: string;
      email: string;
      address: string;
      phone: string;
      statement: boolean;
      consent_jurisdiction: boolean;
    };

    if (!name || !email || !address || !phone) {
      return c.json({ error: 'Name, email, address, and phone are required' }, 400);
    }

    if (!statement) {
      return c.json(
        {
          error:
            'You must declare under penalty of perjury that the material was removed due to mistake or misidentification',
        },
        400,
      );
    }

    if (!consent_jurisdiction) {
      return c.json({ error: 'You must consent to the jurisdiction of the federal district court' }, 400);
    }

    const now = new Date();
    const restoreAt = addBusinessDays(now, 14);
    const id = nanoid();

    await c.env.DB.prepare(
      `INSERT INTO counter_notifications
       (id, post_id, user_id, name, email, address, phone, statement, consent_jurisdiction, submitted_at, restore_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        postId,
        userId,
        name,
        email,
        address,
        phone,
        statement ? 1 : 0,
        consent_jurisdiction ? 1 : 0,
        now.toISOString(),
        restoreAt.toISOString(),
      )
      .run();

    // Notify admins
    await insertAdminAlert(c.env.DB, postId, 'copyright', 'high');

    return c.json({ success: true, counter_id: id, restore_at: restoreAt.toISOString() });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Counter-notice error:', error);
    return c.json({ error: 'Failed to file counter-notice', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/notifications - fetch notifications (protected)
app.get('/api/notifications', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get notifications with post and actor info (optimized: LIMIT first, then JOIN)
    const result = await c.env.DB.prepare(`
      SELECT 
        n.id,
        n.type,
        n.post_id,
        n.read,
        n.created_at,
        n.actor_id,
        n.actor_data,
        SUBSTR(p.text, 1, 50) as post_text_preview,
        u.username as actor_username,
        u.display_name as actor_display_name,
        u.avatar_key as actor_avatar_key
      FROM (
        SELECT * FROM notifications 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 20
      ) n
      LEFT JOIN posts p ON n.post_id = p.id
      LEFT JOIN users u ON n.actor_id = u.id
    `)
      .bind(userId)
      .all();

    if (!result.success) {
      return c.json({ error: 'Failed to fetch notifications' }, 500);
    }

    // Get unread count
    const unreadResult = (await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0',
    )
      .bind(userId)
      .first()) as { count: number };

    // Format notifications
    const rows = result.results || [];

    // Collect all actor IDs from actor_data for grouped fresh notifications
    const allActorIds = new Set<string>();
    for (const row of rows) {
      if (row.type === 'fresh' && row.actor_data) {
        try {
          const ids = JSON.parse(row.actor_data as string);
          if (Array.isArray(ids)) ids.forEach((id: string) => void allActorIds.add(id));
        } catch {}
      }
    }

    // Fetch user info for all grouped actors
    const actorUserMap = new Map<string, Record<string, unknown>>();
    if (allActorIds.size > 0) {
      const userRows = await c.env.DB.prepare(`
        SELECT id, username, display_name, avatar_key FROM users WHERE id IN (${Array.from(allActorIds)
          .map(() => '?')
          .join(',')})
      `)
        .bind(...Array.from(allActorIds))
        .all();
      for (const u of (userRows.results || []) as Array<Record<string, unknown>>) {
        actorUserMap.set(u.id as string, u);
      }
    }

    const notifications = rows.map((row: Record<string, unknown>) => {
      const notif: Record<string, unknown> = {
        id: row.id,
        type: row.type,
        post_id: row.post_id,
        post_text_preview: row.post_text_preview,
        actor: row.actor_username
          ? {
              username: row.actor_username,
              display_name: row.actor_display_name,
              avatar_key: row.actor_avatar_key,
            }
          : undefined,
        actor_id: row.actor_id,
        actor_data: row.actor_data,
        read: row.read === 1,
        created_at: row.created_at,
      };

      // For fresh notifications with grouped actors, include all actors
      if (row.type === 'fresh' && row.actor_data) {
        try {
          const ids = JSON.parse(row.actor_data as string);
          if (Array.isArray(ids) && ids.length > 1) {
            notif.actors = ids
              .map((id: string) => {
                const u = actorUserMap.get(id);
                return u ? { username: u.username, display_name: u.display_name, avatar_key: u.avatar_key } : null;
              })
              .filter(Boolean);
          }
        } catch {}
      }

      return notif;
    });

    return c.json({
      notifications,
      unread_count: unreadResult?.count || 0,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Fetch notifications error:', error);
    return c.json({ error: 'Failed to fetch notifications', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/notifications/read-all - mark all notifications as read (protected)
app.post('/api/notifications/read-all', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    await c.env.DB.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').bind(userId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Mark all read error:', error);
    return c.json({ error: 'Failed to mark notifications as read', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Direct Messages (extracted to routes/messenger.ts) ────────────────────────
app.route('/api', messengerRouter);

// ─── Group Chat ────────────────────────────────────────────────────────────────

// GET /api/groups - list user's groups with last message and unread count
app.get('/api/groups', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    const groups = await c.env.DB.prepare(`
      SELECT
        g.id, g.name, g.description, g.icon_key, g.created_by, g.created_at, g.key_version,
        gm.role as my_role,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
        (SELECT CASE WHEN enc_version IS NOT NULL THEN '[Encrypted message]' ELSE content END FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_content,
        (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_created_at,
        (SELECT sender_id FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_sender_id,
        COALESCE(grs.unread_count, 0) as unread_count
      FROM group_conversations g
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      LEFT JOIN group_read_states grs ON grs.group_id = g.id AND grs.user_id = ?
      ORDER BY COALESCE(
        (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1),
        g.created_at
      ) DESC
    `)
      .bind(userId, userId)
      .all();

    return c.json({
      groups: (groups.results || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        icon_key: row.icon_key,
        created_by: row.created_by,
        created_at: row.created_at,
        key_version: row.key_version || 1,
        my_role: row.my_role,
        member_count: row.member_count,
        last_message: row.last_message_content
          ? {
              content: row.last_message_content,
              sender_id: row.last_message_sender_id,
              created_at: row.last_message_created_at,
              is_mine: row.last_message_sender_id === userId,
            }
          : null,
        unread_count: row.unread_count,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Groups list error:', error);
    return c.json({ error: 'Failed to fetch groups', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups - create a new group
app.post('/api/groups', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const { name, description, memberIds } = (await c.req.json()) as {
      name?: string;
      description?: string;
      memberIds?: string[];
    };

    if (!name || name.trim().length === 0) {
      return c.json({ error: 'Group name is required' }, 400);
    }
    if (name.trim().length > 50) {
      return c.json({ error: 'Group name must be 50 characters or less' }, 400);
    }
    if (!memberIds || memberIds.length === 0) {
      return c.json({ error: 'At least one member is required' }, 400);
    }
    if (memberIds.length > 50) {
      return c.json({ error: 'Maximum 50 members per group' }, 400);
    }
    if (memberIds.includes(userId)) {
      return c.json({ error: 'You are already included automatically' }, 400);
    }

    const now = new Date().toISOString();
    const groupId = nanoid();

    // Insert group
    await c.env.DB.prepare(
      'INSERT INTO group_conversations (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(groupId, name.trim(), (description || '').trim(), userId, now)
      .run();

    // Insert owner as member
    await c.env.DB.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .bind(groupId, userId, now)
      .run();

    // Insert initial members (batched)
    if (memberIds.length > 0) {
      await c.env.DB.batch(
        memberIds.map((mid: string) =>
          c.env.DB.prepare(
            "INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
          ).bind(groupId, mid, now),
        ),
      );
    }

    return c.json({ id: groupId });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group create error:', error);
    return c.json({ error: 'Failed to create group', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/groups/unread-count - get total unread group count
app.get('/api/groups/unread-count', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    const result = (await c.env.DB.prepare(`
      SELECT COALESCE(SUM(grs.unread_count), 0) as count
      FROM group_read_states grs
      JOIN group_members gm ON gm.group_id = grs.group_id AND gm.user_id = grs.user_id
      WHERE grs.user_id = ?
    `)
      .bind(userId)
      .first()) as { count: number };

    return c.json({ unread_count: result?.count || 0 });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group unread count error:', error);
    return c.json({ error: 'Failed to get unread count', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/groups/:id - get group details
app.get('/api/groups/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');

    const group = (await c.env.DB.prepare(`
      SELECT g.id, g.name, g.description, g.icon_key, g.created_by, g.created_at, g.key_version,
             gm.role as my_role
      FROM group_conversations g
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      WHERE g.id = ?
    `)
      .bind(userId, groupId)
      .first()) as Record<string, unknown> | null;

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    // Get members
    const members = await c.env.DB.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_key, gm.role, gm.joined_at
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY gm.joined_at ASC
    `)
      .bind(groupId)
      .all();

    return c.json({
      id: group.id,
      name: group.name,
      description: group.description,
      icon_key: group.icon_key,
      created_by: group.created_by,
      created_at: group.created_at,
      key_version: group.key_version || 1,
      my_role: group.my_role,
      members: (members.results || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        avatar_key: row.avatar_key,
        role: row.role,
        joined_at: row.joined_at,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group get error:', error);
    return c.json({ error: 'Failed to fetch group', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/groups/:id - update group name/description/icon
app.put('/api/groups/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { name, description } = (await c.req.json()) as { name?: string; description?: string };

    // Check membership and role
    const member = (await c.env.DB.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role IN ('owner', 'admin')",
    )
      .bind(groupId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to edit this group' }, 403);
    }

    if (name !== undefined) {
      if (name.trim().length === 0) return c.json({ error: 'Group name cannot be empty' }, 400);
      if (name.trim().length > 50) return c.json({ error: 'Group name must be 50 characters or less' }, 400);
      await c.env.DB.prepare('UPDATE group_conversations SET name = ? WHERE id = ?').bind(name.trim(), groupId).run();
    }

    if (description !== undefined) {
      await c.env.DB.prepare('UPDATE group_conversations SET description = ? WHERE id = ?')
        .bind(description.trim(), groupId)
        .run();
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group update error:', error);
    return c.json({ error: 'Failed to update group', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/groups/:id - delete group (owner only)
app.delete('/api/groups/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');

    const member = (await c.env.DB.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role = 'owner'",
    )
      .bind(groupId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Only the owner can delete the group' }, 403);
    }

    // Delete associated files from R2
    if (c.env.BUCKET) {
      const msgs = await c.env.DB.prepare(
        'SELECT gif_key, payload_key, swf_key FROM group_messages WHERE group_id = ? AND (gif_key IS NOT NULL OR payload_key IS NOT NULL OR swf_key IS NOT NULL)',
      )
        .bind(groupId)
        .all();

      for (const msg of msgs.results || []) {
        const m = msg as Record<string, string | null>;
        for (const key of [m.gif_key, m.payload_key, m.swf_key]) {
          if (key)
            try {
              await c.env.BUCKET.delete(key);
            } catch {
              /* ignore */
            }
        }
      }
    }

    await c.env.DB.prepare('DELETE FROM group_conversations WHERE id = ?').bind(groupId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group delete error:', error);
    return c.json({ error: 'Failed to delete group', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/members - add members to group
app.post('/api/groups/:id/members', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { memberIds } = (await c.req.json()) as { memberIds?: string[] };

    if (!memberIds || memberIds.length === 0) {
      return c.json({ error: 'memberIds is required' }, 400);
    }

    // Check authorization (owner or admin)
    const member = (await c.env.DB.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role IN ('owner', 'admin')",
    )
      .bind(groupId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to add members' }, 403);
    }

    const now = new Date().toISOString();

    if (memberIds.length > 0) {
      await c.env.DB.batch(
        memberIds.map((mid: string) =>
          c.env.DB.prepare(
            "INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
          ).bind(groupId, mid, now),
        ),
      );
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group add member error:', error);
    return c.json({ error: 'Failed to add members', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/groups/:id/members/:userId - remove member or leave
app.delete('/api/groups/:id/members/:userId', requireAuth, async (c) => {
  try {
    const currentUserId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const targetUserId = c.req.param('userId');

    const targetMember = (await c.env.DB.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, targetUserId)
      .first()) as { role: string } | null;

    if (!targetMember) {
      return c.json({ error: 'Member not found' }, 404);
    }

    // Allow if: current user is removing themselves, or current user is owner/admin
    if (targetUserId !== currentUserId) {
      const myMember = (await c.env.DB.prepare(
        "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role IN ('owner', 'admin')",
      )
        .bind(groupId, currentUserId)
        .first()) as { role: string } | null;

      if (!myMember) {
        return c.json({ error: 'Not authorized to remove members' }, 403);
      }

      // Cannot remove the owner
      if (targetMember.role === 'owner') {
        return c.json({ error: 'Cannot remove the group owner' }, 403);
      }

      // Admins cannot remove other admins (unless they're the owner)
      if (targetMember.role === 'admin' && myMember.role !== 'owner') {
        return c.json({ error: 'Only the owner can remove admins' }, 403);
      }
    }

    // Delete read states for this user
    await c.env.DB.prepare('DELETE FROM group_read_states WHERE group_id = ? AND user_id = ?')
      .bind(groupId, targetUserId)
      .run();

    await c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, targetUserId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group remove member error:', error);
    return c.json({ error: 'Failed to remove member', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/groups/:id/messages - get group messages (cursor-based)
app.get('/api/groups/:id/messages', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const cursor = c.req.query('cursor');
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);

    // Verify membership
    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    let messages: { results?: Array<Record<string, unknown>> };
    if (cursor) {
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.group_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
                m.content_iv, m.enc_version, m.key_version,
                m.stamp_id,
                u.username as sender_username, u.display_name as sender_display_name,
               u.avatar_key as sender_avatar_key
        FROM group_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.group_id = ? AND m.created_at < ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
        .bind(groupId, cursor, limit)
        .all();
    } else {
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.group_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
                m.content_iv, m.enc_version, m.key_version,
                m.stamp_id,
                u.username as sender_username, u.display_name as sender_display_name,
               u.avatar_key as sender_avatar_key
        FROM group_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.group_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
        .bind(groupId, limit)
        .all();
    }

    const rows = (messages.results || []) as Array<Record<string, unknown>>;
    const nextCursor = rows.length === limit ? (rows[rows.length - 1].created_at as string) : null;

    // Batch-fetch stamp data for messages that have stamp_id
    const stampIds = [...new Set(rows.filter((r) => r.stamp_id).map((r) => r.stamp_id as string))];
    const stampMap = new Map<string, { name: string; image_key: string }>();
    if (stampIds.length > 0) {
      const placeholders = stampIds.map(() => '?').join(',');
      const stampRows = await c.env.DB.prepare(
        `SELECT id, name, image_key FROM custom_stamps WHERE id IN (${placeholders})`,
      )
        .bind(...stampIds)
        .all<{ id: string; name: string; image_key: string }>();
      for (const s of stampRows.results || []) {
        stampMap.set(s.id, { name: s.name, image_key: s.image_key });
      }
    }

    return c.json({
      messages: rows.map((row) => {
        const stamp = row.stamp_id ? stampMap.get(row.stamp_id as string) : undefined;
        return {
          id: row.id,
          group_id: row.group_id,
          sender_id: row.sender_id,
          content: row.content,
          gif_key: row.gif_key || null,
          payload_key: row.payload_key || null,
          swf_key: row.swf_key || null,
          content_iv: row.content_iv || null,
          enc_version: row.enc_version || null,
          key_version: row.key_version || null,
          stamp_id: row.stamp_id || null,
          stamp_url: stamp ? `/api/images/${stamp.image_key}` : null,
          stamp_name: stamp ? stamp.name : null,
          created_at: row.created_at,
          edited_at: row.edited_at || null,
          is_mine: row.sender_id === userId,
          sender: {
            id: row.sender_id,
            username: row.sender_username,
            display_name: row.sender_display_name,
            avatar_key: row.sender_avatar_key || null,
          },
        };
      }),
      next_cursor: nextCursor,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group messages error:', error);
    return c.json({ error: 'Failed to fetch messages', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/messages - send a message to a group
app.post('/api/groups/:id/messages', requireAuth, async (c) => {
  try {
    const senderId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { content, gifKey, payloadKey, swfKey, messageId, contentIv, encVersion, keyVersion, stampId } =
      (await c.req.json()) as {
        content?: string;
        gifKey?: string;
        payloadKey?: string;
        swfKey?: string;
        messageId?: string;
        contentIv?: string;
        encVersion?: number;
        keyVersion?: number;
        stampId?: string;
      };

    const trimmed = content?.trim() || '';
    if (!trimmed && !gifKey && !payloadKey && !swfKey && !stampId) {
      return c.json({ error: 'Content or file attachment is required' }, 400);
    }
    const isEncrypted = typeof encVersion === 'number' && encVersion > 0;
    const maxLen = isEncrypted ? 2000 : 200;
    if (trimmed.length > maxLen) {
      return c.json({ error: `Message must be ${maxLen} characters or less` }, 400);
    }

    // Verify membership
    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, senderId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    // Validate stampId if provided
    let stampUrl: string | null = null;
    let stampName: string | null = null;
    if (stampId) {
      const stamp = await c.env.DB.prepare('SELECT id, name, image_key FROM custom_stamps WHERE id = ? AND user_id = ?')
        .bind(stampId, senderId)
        .first<{ id: string; name: string; image_key: string }>();
      if (!stamp) {
        return c.json({ error: 'Stamp not found' }, 404);
      }
      stampUrl = `/api/images/${stamp.image_key}`;
      stampName = stamp.name;
    }

    const msgId = messageId || nanoid();
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      'INSERT INTO group_messages (id, group_id, sender_id, content, created_at, gif_key, payload_key, swf_key, content_iv, enc_version, key_version, stamp_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        msgId,
        groupId,
        senderId,
        trimmed,
        now,
        gifKey || null,
        payloadKey || null,
        swfKey || null,
        contentIv || null,
        isEncrypted ? encVersion : null,
        keyVersion || 1,
        stampId || null,
      )
      .run();

    // Reset unread count for self, increment for all other members
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO group_read_states (user_id, group_id, last_read_message_id, unread_count) VALUES (?, ?, ?, 0)',
    )
      .bind(senderId, groupId, msgId)
      .run();

    // Increment unread for other members (insert or update) — batched
    const otherMembers = await c.env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?')
      .bind(groupId, senderId)
      .all();

    const otherIds = (otherMembers.results || []) as Array<{ user_id: string }>;
    if (otherIds.length > 0) {
      const stmts = otherIds.map((m) =>
        c.env.DB.prepare(`
          INSERT INTO group_read_states (user_id, group_id, last_read_message_id, unread_count)
          VALUES (?, ?, NULL, 1)
          ON CONFLICT(user_id, group_id) DO UPDATE SET unread_count = unread_count + 1
        `).bind(m.user_id, groupId),
      );
      await c.env.DB.batch(stmts);
    }

    const sender = c.get('user');
    return c.json({
      id: msgId,
      group_id: groupId,
      sender_id: senderId,
      content: trimmed,
      gif_key: gifKey || null,
      payload_key: payloadKey || null,
      swf_key: swfKey || null,
      content_iv: contentIv || null,
      enc_version: isEncrypted ? encVersion : null,
      key_version: isEncrypted ? keyVersion || 1 : null,
      stamp_id: stampId || null,
      stamp_url: stampUrl,
      stamp_name: stampName,
      created_at: now,
      edited_at: null,
      is_mine: true,
      sender: {
        id: senderId,
        username: sender?.username || '',
        display_name: sender?.display_name || sender?.username || '',
        avatar_key: null,
      },
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group send message error:', error);
    return c.json({ error: 'Failed to send message', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/messages/prepare - prepare file attachment upload
app.post('/api/groups/:id/messages/prepare', requireAuth, async (c) => {
  try {
    const senderId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { filename } = (await c.req.json()) as { filename?: string };

    if (!filename) {
      return c.json({ error: 'Missing filename' }, 400);
    }

    // Verify membership
    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, senderId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];
    const msgId = nanoid();

    let storageKey: string;
    let responseType: 'gif' | 'zip' | 'swf';

    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `group/swf/${msgId}.swf`;
      responseType = 'swf';
    } else if (name.endsWith('.zip')) {
      storageKey = `group/zip/${msgId}.zip`;
      responseType = 'zip';
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `group/html/${msgId}.html`;
      responseType = 'zip';
    } else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `group/audio/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `group/video/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = {
        png: '.png',
        jpg: '.jpg',
        jpeg: '.jpg',
        gif: '.gif',
        webp: '.webp',
        svg: '.svg',
        bmp: '.bmp',
        ico: '.ico',
      };
      storageKey = `group/gif/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else {
      return c.json({ error: 'Unsupported file type' }, 400);
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/groups/upload/${storageKey}`;
    const resp: Record<string, unknown> = { msgId, uploadUrl, storageKey };

    if (responseType === 'zip') {
      resp.payloadKey = storageKey;
    } else if (responseType === 'swf') {
      resp.swfKey = storageKey;
    } else {
      resp.gifKey = storageKey;
    }

    return c.json(resp);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group prepare error:', error);
    return c.json({ error: 'Failed to prepare message', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/groups/upload/:key — direct file upload for group messages
app.put('/api/groups/upload/*', requireAuth, async (c) => {
  try {
    const key = c.req.path.replace('/api/groups/upload/', '');
    const contentLength = c.req.header('content-length');

    if (!key) {
      return c.json({ error: 'Missing file key' }, 400);
    }

    const maxSize = 25 * 1024 * 1024;
    if (contentLength && Number(contentLength) > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413);
    }

    const fileData = await c.req.arrayBuffer();
    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const detectedMime = detectMimeType(fileData);
    if (!detectedMime) {
      return c.json({ error: 'Unrecognized file format. Magic bytes do not match any allowed type.' }, 400);
    }
    if (
      !isAllowedImageMime(detectedMime) &&
      !detectedMime.startsWith('audio/') &&
      !detectedMime.startsWith('video/') &&
      detectedMime !== 'application/zip' &&
      detectedMime !== 'application/x-shockwave-flash' &&
      detectedMime !== 'text/html'
    ) {
      return c.json({ error: 'File type not allowed' }, 400);
    }

    // Reject oversized images to prevent renderer OOM crashes when decoded in the browser
    const dimError = validateImageDimensions(fileData, detectedMime);
    if (dimError) {
      return c.json({ error: dimError }, 413);
    }

    await c.env.BUCKET.put(key, fileData, {
      httpMetadata: { contentType: detectedMime },
    });

    return c.json({ success: true, key });
  } catch (error: unknown) {
    console.error('Group upload error:', error);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// PUT /api/groups/:id/messages/:msgId - edit a group message
app.put('/api/groups/:id/messages/:msgId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const msgId = c.req.param('msgId');
    const { content, contentIv, encVersion, keyVersion } = (await c.req.json()) as {
      content?: string;
      contentIv?: string;
      encVersion?: number;
      keyVersion?: number;
    };

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return c.json({ error: 'Content is required' }, 400);
    }

    const trimmed = content.trim();
    const isEncrypted = typeof encVersion === 'number' && encVersion > 0;
    const maxLen = isEncrypted ? 2000 : 200;
    if (trimmed.length > maxLen) {
      return c.json({ error: `Message must be ${maxLen} characters or less` }, 400);
    }

    const msg = (await c.env.DB.prepare(
      'SELECT id, content, content_iv, enc_version, key_version FROM group_messages WHERE id = ? AND group_id = ? AND sender_id = ?',
    )
      .bind(msgId, groupId, userId)
      .first()) as {
      id: string;
      content: string;
      content_iv: string | null;
      enc_version: number | null;
      key_version: number | null;
    } | null;

    if (!msg) {
      return c.json({ error: 'Message not found or not yours to edit' }, 404);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'UPDATE group_messages SET content = ?, edited_at = ?, content_iv = ?, enc_version = ?, key_version = ? WHERE id = ?',
    )
      .bind(
        trimmed,
        now,
        contentIv || msg.content_iv || null,
        isEncrypted ? encVersion : msg.enc_version || null,
        keyVersion || msg.key_version || 1,
        msgId,
      )
      .run();

    return c.json({
      id: msgId,
      content: trimmed,
      content_iv: contentIv || null,
      enc_version: isEncrypted ? encVersion : null,
      key_version: keyVersion || null,
      edited_at: now,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group edit message error:', error);
    return c.json({ error: 'Failed to edit message', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/groups/:id/messages/:msgId - delete a group message
app.delete('/api/groups/:id/messages/:msgId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const msgId = c.req.param('msgId');

    const msg = (await c.env.DB.prepare(
      'SELECT id, sender_id, gif_key, payload_key, swf_key FROM group_messages WHERE id = ? AND group_id = ?',
    )
      .bind(msgId, groupId)
      .first()) as {
      id: string;
      sender_id: string;
      gif_key?: string;
      payload_key?: string;
      swf_key?: string;
    } | null;

    if (!msg) {
      return c.json({ error: 'Message not found' }, 404);
    }

    if (msg.sender_id !== userId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (c.env.BUCKET) {
      for (const key of [msg.gif_key, msg.payload_key, msg.swf_key]) {
        if (key)
          try {
            await c.env.BUCKET.delete(key);
          } catch {
            /* ignore */
          }
      }
    }

    await c.env.DB.prepare('DELETE FROM group_messages WHERE id = ?').bind(msgId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group delete message error:', error);
    return c.json({ error: 'Failed to delete message', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/read - mark group as read
app.post('/api/groups/:id/read', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');

    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const lastMsg = (await c.env.DB.prepare(
      'SELECT id FROM group_messages WHERE group_id = ? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(groupId)
      .first()) as { id: string } | null;

    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO group_read_states (user_id, group_id, last_read_message_id, unread_count) VALUES (?, ?, ?, 0)',
    )
      .bind(userId, groupId, lastMsg?.id || null)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group mark read error:', error);
    return c.json({ error: 'Failed to mark as read', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/keys - submit wrapped group keys (rotation on membership changes)
app.post('/api/groups/:id/keys', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { keyVersion, boxes } = (await c.req.json()) as {
      keyVersion?: number;
      boxes?: Array<{ userId: string; wrappedKey: string; wrappedIv: string }>;
    };

    if (typeof keyVersion !== 'number' || !boxes || boxes.length === 0) {
      return c.json({ error: 'keyVersion and boxes are required' }, 400);
    }

    const myMember = (await c.env.DB.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .first()) as { role: string } | null;

    if (!myMember) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const canManage = myMember.role === 'owner' || myMember.role === 'admin';
    if (!canManage && boxes.some((b) => b.userId !== userId)) {
      return c.json({ error: 'Not authorized to submit keys for other members' }, 403);
    }

    const memberIds = await c.env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .bind(groupId)
      .all();
    const currentIds = new Set((memberIds.results || []).map((r) => (r as { user_id: string }).user_id));

    for (const b of boxes) {
      if (!currentIds.has(b.userId)) {
        return c.json({ error: 'Key recipient is not a current member' }, 400);
      }
    }

    await c.env.DB.batch(
      boxes.map((b) =>
        c.env.DB.prepare(`
          INSERT INTO group_channel_keys (group_id, key_version, user_id, wrapped_key, wrapped_iv, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(group_id, key_version, user_id) DO UPDATE SET
            wrapped_key = excluded.wrapped_key,
            wrapped_iv = excluded.wrapped_iv
        `).bind(groupId, keyVersion, b.userId, b.wrappedKey, b.wrappedIv, new Date().toISOString()),
      ),
    );

    await c.env.DB.prepare('UPDATE group_conversations SET key_version = ? WHERE id = ?')
      .bind(keyVersion, groupId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group keys error:', error);
    return c.json({ error: 'Failed to store keys', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/groups/:id/keys - fetch my wrapped keys for a group
app.get('/api/groups/:id/keys', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');

    const group = (await c.env.DB.prepare('SELECT key_version FROM group_conversations WHERE id = ?')
      .bind(groupId)
      .first()) as { key_version: number } | null;

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const keys = await c.env.DB.prepare(
      'SELECT key_version, wrapped_key, wrapped_iv FROM group_channel_keys WHERE group_id = ? AND user_id = ?',
    )
      .bind(groupId, userId)
      .all();

    return c.json({
      key_version: group.key_version,
      keys: (keys.results || []).map((row: Record<string, unknown>) => ({
        key_version: row.key_version,
        wrapped_key: row.wrapped_key,
        wrapped_iv: row.wrapped_iv,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group keys get error:', error);
    return c.json({ error: 'Failed to fetch keys', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Messenger E2EE identity keys ─────────────────────────────────────────────

// GET /api/messenger/keys - get my identity public key + encrypted private key
app.get('/api/messenger/keys', requireAuth, async (c) => {
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
app.put('/api/messenger/keys', requireAuth, async (c) => {
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
app.post('/api/messenger/keys/bulk', requireAuth, async (c) => {
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
app.get('/api/messenger/identity-v2', requireAuth, async (c) => {
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
app.get('/api/messenger/prekeys', requireAuth, async (c) => {
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
app.post('/api/messenger/opks/consume', requireAuth, async (c) => {
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
app.put('/api/messenger/identity-v2', requireAuth, async (c) => {
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
app.put('/api/messenger/ratchet-session', requireAuth, async (c) => {
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
app.get('/api/messenger/ratchet-session', requireAuth, async (c) => {
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
app.delete('/api/messenger/ratchet-session', requireAuth, async (c) => {
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
app.post('/api/messenger/ratchet-reset', requireAuth, async (c) => {
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
app.get('/api/messenger/ratchet-reset', requireAuth, async (c) => {
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
app.delete('/api/messenger/ratchet-reset', requireAuth, async (c) => {
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
app.get('/api/messenger/opks', requireAuth, async (c) => {
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
app.post('/api/messenger/opks', requireAuth, async (c) => {
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

// ── Server Routes (extracted to routes/servers.ts) ──────────────────────────
app.route('/api', serversRouter);

// ── Tests Routes (extracted to routes/tests.ts) ──────────────────────────────
app.route('/', testsRouter);

// Get current topic - randomly selected Flash/HTML post
app.get('/api/current-topic', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get a random Flash/HTML post — sample 50 candidate IDs, pick one randomly
    const candidates = await c.env.DB.prepare(`
      SELECT id FROM posts
      WHERE (swf_key IS NOT NULL OR payload_key IS NOT NULL)
        AND status = 'published'
        AND hidden = 0
        AND parent_id IS NULL
      ORDER BY id
      LIMIT 50
    `).all<{ id: string }>();

    if (!candidates.results?.length) {
      return c.json({ error: 'No Flash/HTML posts found' }, 404);
    }

    const pick = candidates.results[Math.floor(Math.random() * candidates.results.length)];
    const result = await c.env.DB.prepare(`
      SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.created_at,
             u.display_name, u.avatar_key, u.language as author_language,
             COALESCE(p.reply_count, 0) as reply_count,
             COALESCE(p.impressions, 0) as impressions,
             p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `)
      .bind(pick.id)
      .first();

    if (!result) {
      return c.json({ error: 'No Flash/HTML posts found' }, 404);
    }

    let hashtags = [];
    try {
      hashtags = result.hashtags
        ? typeof result.hashtags === 'string'
          ? JSON.parse(result.hashtags)
          : result.hashtags
        : [];
    } catch (error) {
      console.warn('Failed to parse hashtags:', error);
      hashtags = [];
    }

    const topicPost = {
      id: result.id,
      user_id: result.user_id,
      username: result.username,
      display_name: result.display_name,
      avatar_key: result.avatar_key,
      text: result.text,
      hashtags,
      gif_key: result.gif_key,
      payload_key: result.payload_key,
      swf_key: result.swf_key,
      thumbnail_key: result.thumbnail_key,
      fresh_count: result.fresh_count,
      reply_count: result.reply_count,
      impressions: result.impressions,
      created_at: result.created_at,
      type: result.swf_key ? 'flash' : 'html',
    };

    return c.json(topicPost);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Current topic fetch error:', error);
    return c.json({ error: 'Internal server error', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Call API (extracted to routes/calls.ts) ──────────────────────────────────
app.route('/api', callsRouter);

// ── Push & Notifications Routes (extracted to routes/push.ts) ────────────────
app.route('/api', pushRouter);

// ── Multiplayer Routes (extracted to routes/multiplayer.ts) ──────────────────
app.route('/api/multiplayer', multiplayerRouter);

// ── Admin Routes (extracted to routes/admin.ts) ──────────────────────────────
app.route('/api/admin', adminRouter);

// GET /api/posts/:id/versions - list archived versions of a game (public)
app.get('/api/posts/:id/versions', async (c) => {
  try {
    const postId = c.req.param('id');
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const { results } = (await c.env.DB.prepare(
      'SELECT id, version_number, changelog, thumbnail_key, created_at FROM game_versions WHERE post_id = ? ORDER BY version_number DESC',
    )
      .bind(postId)
      .all()) as {
      results: Array<{
        id: string;
        version_number: number;
        changelog: string | null;
        thumbnail_key: string | null;
        created_at: string;
      }>;
    };

    const versions = results.map((r) => ({
      id: r.id,
      versionNumber: r.version_number,
      changelog: r.changelog || null,
      thumbnailKey: r.thumbnail_key || null,
      createdAt: r.created_at,
    }));

    return c.json({ versions });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('List game versions error:', error);
    return c.json({ error: 'Failed to list versions', details: err.message }, 500);
  }
});

// POST /api/posts/:id/versions/prepare - reserve an upload slot for a new version (owner only)
app.post('/api/posts/:id/versions/prepare', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id');
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const post = (await c.env.DB.prepare('SELECT id, user_id, payload_key, status FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as { id: string; user_id: string; payload_key: string | null; status: string } | null;

    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Post is not published' }, 400);
    if (
      !post.payload_key ||
      !(
        post.payload_key.startsWith('zip/') ||
        post.payload_key.startsWith('html/') ||
        post.payload_key.startsWith('payload/') ||
        post.payload_key.startsWith('versions/')
      )
    ) {
      return c.json({ error: 'Only ZIP/HTML5 games can be versioned' }, 400);
    }

    const versionId = crypto.randomUUID();
    const storageKey = `versions/${postId}/${versionId}.zip`;
    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;

    return c.json({ postId, versionId, zipUploadUrl: uploadUrl, zipKey: storageKey });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Prepare game version error:', error);
    return c.json({ error: 'Failed to prepare version', details: err.message }, 500);
  }
});

// POST /api/posts/:id/versions/commit - finalize a newly uploaded version (owner only)
app.post('/api/posts/:id/versions/commit', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id')!;
    if (!c.env.DB || !c.env.BUCKET) return c.json({ error: 'Database/Storage not available' }, 500);

    const body = (await c.req.json()) as { versionId?: string; changelog?: string };
    if (!body.versionId) return c.json({ error: 'versionId is required' }, 400);

    const post = (await c.env.DB.prepare('SELECT id, user_id, payload_key, status, created_at FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      payload_key: string | null;
      status: string;
      created_at: string;
    } | null;

    if (!post || post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Post is not published' }, 400);

    const newKey = `versions/${postId}/${body.versionId}.zip`;
    const head = await c.env.BUCKET.head(newKey);
    if (!head) return c.json({ error: 'Uploaded file not found' }, 400);

    const maxRow = (await c.env.DB.prepare('SELECT MAX(version_number) as m FROM game_versions WHERE post_id = ?')
      .bind(postId)
      .first()) as { m: number | null } | null;
    const max = maxRow?.m ?? 0;

    const now = new Date().toISOString();
    const changelog = typeof body.changelog === 'string' ? body.changelog.trim().slice(0, 2000) || null : null;

    // Archive the original release as v1 the first time a game is versioned,
    // so players can still roll back to it after an update.
    if (max === 0 && post.payload_key && post.payload_key !== newKey) {
      await c.env.DB.prepare(
        'INSERT INTO game_versions (id, post_id, version_number, payload_key, thumbnail_key, changelog, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(crypto.randomUUID(), postId, 1, post.payload_key, null, null, user.id, post.created_at)
        .run();
    }

    const newVersionNumber = max + 1;
    await c.env.DB.prepare(
      'INSERT INTO game_versions (id, post_id, version_number, payload_key, thumbnail_key, changelog, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(body.versionId, postId, newVersionNumber, newKey, null, changelog, user.id, now)
      .run();

    await c.env.DB.prepare('UPDATE posts SET payload_key = ?, edited_at = ?, created_at = ? WHERE id = ?')
      .bind(newKey, now, now, postId)
      .run();

    const execCtx = (c as unknown as { executionCtx?: { waitUntil: (p: Promise<unknown>) => void } }).executionCtx;
    if (execCtx?.waitUntil) {
      const bucket = c.env.BUCKET;
      const db = c.env.DB;
      const versionId = body.versionId ?? null;
      if (bucket && db) {
        execCtx.waitUntil(
          (async () => {
            try {
              // Extract to the default (non-versioned) path so the latest version
              // serves from the plain /api/wvfs-zip/<postId> URL, and to the
              // versioned path so ?v=<id> also resolves to it.
              await extractZipToR2(bucket, newKey, postId);
              if (versionId) {
                await extractZipToR2(bucket, newKey, postId, versionId);
              }
            } catch (e) {
              console.error('Background ZIP extraction failed for version:', e);
            }
            try {
              await extractGameDescription(bucket, db, newKey, postId);
            } catch (e) {
              console.error('Background game description extraction failed:', e);
            }
          })(),
        );
      }
    }

    return c.json({ ok: true, versionId: body.versionId, versionNumber: newVersionNumber });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Commit game version error:', error);
    return c.json({ error: 'Failed to commit version', details: err.message }, 500);
  }
});

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
