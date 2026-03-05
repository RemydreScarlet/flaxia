---
trigger: always_on
---

# Flaxia — Project Rules (Cloudflare Pages Edition)

## Project Identity
Flaxia is a chronological SNS where posts are living, interactive applications.
Concept: "Twitter with Flash inside". Spiritual successor to Adobe Flash.

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Cloudflare Pages + Workers | Edge-first, no Node.js server |
| API | Hono (`hono/cloudflare-pages`) | Thin router, runs as Pages Function |
| Rendering | **TBD** — SSR (hono/jsx) or SPA (Vite + React) | Decide before Phase 1 ships |
| Database | Cloudflare D1 (SQLite) | Bound as `DB` in wrangler.toml |
| Storage | Cloudflare R2 | Post payloads, GIF previews |
| Auth | Cloudflare Access (JWT) | Validated via Hono middleware |
| Math | KaTeX (client-side) | CDN import, no SSR needed |
| Icons | Lucide (React or SVG sprite) | Depends on rendering choice |

### Rendering decision guide (pick one before writing components)
- **SSR (hono/jsx)**: less JS shipped, simpler infra, worse DX for interactive UI
- **SPA (Vite + React)**: better DX, natural fit for PostStage interactivity, needs `_worker.js` or Pages Functions for API

Until decided: **keep all UI logic in plain TypeScript files with no framework imports.**
This makes the pivot cheap in either direction.

---

## Design Language
- Primary: `#22c55e` (Fresh Green)
- Background: `#0f172a` (Deep Slate)
- Font: monospace for technical/count data, system-ui for body
- Sharp edges, minimal padding, pro-tool aesthetic
- **Forbidden**: `rounded-3xl`, pastel colors, box shadows on cards

---

## Code Style
- TypeScript strict mode — `noImplicitAny: true`, no `any` escape hatches
- Functions only, no class components
- File naming: `kebab-case` for files, `PascalCase` for exported components/types
- Co-locate types with their module unless used in 3+ places → then `types/`

---

## Project Structure

```
/
├── functions/              # Cloudflare Pages Functions (= Hono routes)
│   └── api/
│       ├── [[route]].ts   # Hono catch-all → api/posts, api/fresh, etc.
│       └── _middleware.ts # CF Access JWT validation
├── src/
│   ├── components/        # UI components (framework-agnostic until decided)
│   ├── lib/
│   │   ├── db.ts          # D1 query helpers
│   │   ├── r2.ts          # R2 upload/fetch helpers
│   │   └── bridge.ts      # postMessage types (shared with sandbox)
│   └── types/
├── public/                # Static assets
├── sandbox/               # Sandbox origin project (see below)
├── wrangler.toml
└── vite.config.ts
```

---

## Cloudflare Bindings (wrangler.toml)

```toml
[[d1_databases]]
binding = "DB"
database_name = "flaxia"
database_id   = "..."   # fill after `wrangler d1 create flaxia`

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "flaxia-content"

[vars]
SANDBOX_ORIGIN = "https://flaxiausercontent.com"   # or Pages preview URL during dev
```

Always access bindings via the Hono context: `c.env.DB`, `c.env.BUCKET`.
Never import wrangler bindings directly — they don't exist at build time.

---

## Auth — Cloudflare Access

- All `/api/*` routes are behind a Cloudflare Access policy (configured in CF dashboard)
- Pages Functions receive a signed `CF_Authorization` cookie + `Cf-Access-Jwt-Assertion` header
- Validate the JWT in `_middleware.ts` using `@cloudflare/workers-oauth-provider` or manual JWKS fetch
- User identity comes from the JWT payload — no separate users table needed for MVP
- **Never** trust `X-Forwarded-User` or any header that isn't the Access JWT

```typescript
// functions/api/_middleware.ts skeleton
import { verifyCloudflareAccess } from '../lib/auth'

export async function onRequest(ctx: EventContext<Env, string, unknown>) {
  const identity = await verifyCloudflareAccess(ctx.request, ctx.env)
  if (!identity) return new Response('Unauthorized', { status: 401 })
  ctx.data.user = identity
  return ctx.next()
}
```

---

## Database — D1

Schema lives in `migrations/`. Run with `wrangler d1 migrations apply flaxia`.

```sql
-- migrations/0001_init.sql
CREATE TABLE posts (
  id          TEXT PRIMARY KEY,          -- nanoid
  user_id     TEXT NOT NULL,             -- from CF Access JWT sub
  username    TEXT NOT NULL,
  text        TEXT NOT NULL CHECK(length(text) <= 200),
  hashtags    TEXT NOT NULL DEFAULT '[]', -- JSON array, filter client-side for MVP
  gif_key     TEXT,                       -- R2 object key
  payload_key TEXT,                       -- R2 object key for JS/Wasm
  fresh_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_posts_created_at ON posts(created_at DESC);

CREATE TABLE follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE freshs (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
```

D1 query pattern — always use prepared statements:
```typescript
const posts = await c.env.DB
  .prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?')
  .bind(limit, offset)
  .all()
```

---

## Storage — R2

- GIF previews: `gif/{post_id}.gif` — public via R2 custom domain
- Post payloads (JS/Wasm): `payload/{post_id}` — served **only** from sandbox origin
- Upload from Pages Function via `c.env.BUCKET.put(key, body)`
- 10MB hard limit enforced server-side: check `Content-Length` before streaming to R2

---

## Sandbox Architecture

### Two-origin model
| Origin | Purpose |
|---|---|
| `flaxia.com` (main Pages) | SNS UI, API, timeline |
| `flaxiausercontent.com` (sandbox) | Executes untrusted post JS/Wasm |

### Sandbox origin — deployment options (TBD)
**Option A** — separate `sandbox/` directory deployed as its own CF Pages project  
**Option B** — same Pages project, routed via CF Workers custom domain  

Until decided: keep `sandbox/` as a standalone directory with its own `wrangler.toml`.
The build output is a single `index.html` + `fresh-bridge.js` served statically.

### iframe rules (NON-NEGOTIABLE)
```html
<iframe
  src="https://flaxiausercontent.com/run/{post_id}"
  sandbox="allow-scripts allow-forms allow-popups"
  allow="fullscreen; web-share"
  referrerpolicy="no-referrer"
/>
```
- `allow-same-origin` is **permanently banned** — removing it is a security regression, not a bug fix
- CSP must be set via HTTP response header (not `<meta>`) by the sandbox origin's Worker
- WebGPU access: request via postMessage bridge only (parent grants, not iframe)

### Sandbox CSP (set by sandbox Worker)
```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  connect-src 'none';
  frame-ancestors https://flaxia.com;
```

---

## postMessage Bridge

All cross-origin communication goes through a typed, validated bridge.

```typescript
// src/lib/bridge.ts  — shared types (copy into sandbox too)
export type ParentMessage =
  | { type: 'REQUEST_FULLSCREEN' }
  | { type: 'REQUEST_FRESH' }
  | { type: 'POST_SCORE'; score: number; label: string }

export type SandboxMessage =
  | { type: 'FULLSCREEN_GRANTED' }
  | { type: 'FULLSCREEN_DENIED' }
```

Parent validates **every** message:
```typescript
window.addEventListener('message', (e) => {
  if (e.origin !== SANDBOX_ORIGIN) return   // hard reject, no fallthrough
  // handle e.data as ParentMessage
})
```

`score` in `POST_SCORE` must be `Number(score)` — reject if `NaN`.

---

## API Design

```
GET  /api/posts?cursor=<created_at>&limit=20          # timeline (following)
GET  /api/posts?hashtag=<tag>&cursor=<created_at>     # hashtag feed
POST /api/posts                                        # create post (multipart)
POST /api/posts/:id/fresh                             # toggle Fresh!
POST /api/follows/:id                                 # follow user
DELETE /api/follows/:id                               # unfollow
```

- Cursor pagination only — no offset, no page numbers
- Timeline is always `ORDER BY created_at DESC` — no ranking signal ever
- Ad slots are injected **client-side** every 8 posts — API returns clean post arrays

---

## Constraints (enforced at both client and server)
- Text: ≤ 200 characters
- Payload: ≤ 10MB
- Timeline: chronological only, no algorithmic sorting, ever
- Ads: static image only in `AdBanner`, no scripts, no tracking pixels

---

## Dev Workflow

```bash
# Install
pnpm install

# Local dev (D1 + R2 local simulation)
wrangler pages dev --d1=DB --r2=BUCKET -- pnpm vite

# D1 migrations
wrangler d1 migrations apply flaxia --local   # dev
wrangler d1 migrations apply flaxia           # prod

# Deploy
wrangler pages deploy dist
```

---

## Open Decisions (resolve before Phase 1)

| # | Decision | Options | Impact |
|---|---|---|---|
| 1 | Rendering strategy | SSR (hono/jsx) vs SPA (Vite+React) | Entire component architecture |
| 2 | Sandbox origin deployment | Separate CF Pages project vs same project custom domain | DevOps complexity |
| 3 | KaTeX rendering | Client-side only vs SSR pre-render | Flash-of-unstyled-math |
