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
import adsRouter from './routes/ads';
import authRouter from './routes/auth';
import callsRouter from './routes/calls';
import topicRouter from './routes/current-topic';
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
import {
  applyBanditRewards,
  cosineSimilarity,
  getProjection,
  loadBanditConfig,
  loadBanditPrior,
  loadBanditState,
  loadDwellStats,
  loadOrComputeInterestVector,
  saveBanditState,
} from './routes/recommender';
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

// GET /api/ads/:id/payload - serve ad payloads from R2
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
