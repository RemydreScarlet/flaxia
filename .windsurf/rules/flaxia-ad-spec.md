---
trigger: model_decision
description: When Make Ad Slot
---


# Flaxia — Ad Slot Specification v1.0

## Overview

A self-operated ad slot rendered inside the Flaxia timeline as a dedicated `AdCard` component, independent from regular `PostCard`. Supports interactive content (ZIP / SWF / GIF / image) up to **200MB**. Ads are shown to all users — guests and authenticated alike.

---

## Supported Formats

| Format | Description | Limit |
|---|---|---|
| `.zip` | `index.html` + assets (JS / CSS / images etc.) | 200MB |
| `.swf` | Ruffle playback | 200MB |
| `.gif` / `.png` / `.jpg` | Static image or animation | 200MB |

### ZIP Expansion — Client-side Blob URL method

ZIP files are expanded in the browser using **JSZip**. All assets are converted to Blob URLs and relative paths in `index.html` are patched before mounting into the sandbox iframe.

```typescript
// src/lib/zip-expand.ts  ← shared with any future ZIP consumer
export async function expandZipToIframe(
  arrayBuffer: ArrayBuffer,
  iframe: HTMLIFrameElement
): Promise<void> {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const blobUrls: Record<string, string> = {}

  await Promise.all(
    Object.entries(zip.files).map(async ([path, file]) => {
      if (file.dir) return
      const blob = await file.async('blob')
      blobUrls[path] = URL.createObjectURL(blob)
    })
  )

  const indexHtml = await zip.files['index.html'].async('text')
  const patched = patchAssetPaths(indexHtml, blobUrls)
  const finalBlob = new Blob([patched], { type: 'text/html' })
  iframe.src = URL.createObjectURL(finalBlob)
}
```

> Because 200MB ZIPs are heavy to expand on the client, the Worker validates the ZIP at upload time before writing to R2.

### ZIP Validation (Worker-side, upload time)

| Check | Rule |
|---|---|
| `index.html` present | Required at ZIP root |
| File count | ≤ 200 files |
| Uncompressed size | ≤ 500MB (zip bomb guard) |
| Forbidden extensions | Reject `.exe` `.php` `.py` and other server-side types |

Returns `400` with a descriptive error message on any violation.

---

## Shared Functions & Types

All of the following **must** be extracted into shared modules and reused by both the post system and the ad system. Duplication is forbidden.

| Shared module | Location | Used by |
|---|---|---|
| Sandbox iframe renderer | `src/lib/sandbox-renderer.ts` | `PostStage`, `AdStage` |
| Ruffle load logic | `src/lib/ruffle-loader.ts` | `PostStage`, `AdStage` |
| postMessage bridge types | `src/lib/bridge.ts` (extend existing) | posts, ads, future consumers |
| R2 upload / delete utilities | `src/lib/r2.ts` (extend existing) | posts, ads, avatars |
| ZIP expansion logic | `src/lib/zip-expand.ts` | ads (posts currently unsupported) |
| Rate limit check | `src/lib/rate-limit.ts` (extend existing) | all rate-limited endpoints |

### Extended bridge types

```typescript
// src/lib/bridge.ts — add to existing ParentMessage / SandboxMessage unions

export type ParentMessage =
  | { type: 'REQUEST_FULLSCREEN' }
  | { type: 'REQUEST_FRESH' }
  | { type: 'POST_SCORE'; score: number; label: string }
  | { type: 'AD_INTERACTION_END'; duration_ms: number }  // ← new

export type SandboxMessage =
  | { type: 'FULLSCREEN_GRANTED' }
  | { type: 'FULLSCREEN_DENIED' }
  | { type: 'FRESH_GRANTED' }
  | { type: 'FRESH_DENIED' }
  | { type: 'SCORE_SUBMITTED'; score: number; label: string }
  | { type: 'RUFFLE_READY' }
  | { type: 'RUFFLE_ERROR'; message: string }
```

### Shared sandbox renderer signature

```typescript
// src/lib/sandbox-renderer.ts
export interface SandboxPayload {
  type: 'zip' | 'swf' | 'gif' | 'image' | 'js'
  url: string          // R2 public URL
  arrayBuffer?: ArrayBuffer  // pre-fetched, required for zip and swf
}

export async function mountSandbox(
  iframe: HTMLIFrameElement,
  payload: SandboxPayload
): Promise<void>
// PostStage and AdStage both call this — no rendering logic lives in either component
```

---

## Storage — R2

| Key pattern | Content |
|---|---|
| `ad/payload/{ad_id}` | ZIP or SWF payload |
| `ad/preview/{ad_id}.{ext}` | GIF or image |

- All ad assets are namespaced under `ad/` — fully isolated from `payload/`, `gif/`, `avatar/`
- Deletion via shared `r2.ts` utility (`deleteObject(key)`)

---

## Database Schema

```sql
-- migrations/0002_ads.sql

CREATE TABLE ads (
  id           TEXT PRIMARY KEY,  -- nanoid
  title        TEXT NOT NULL,     -- admin-only label, never shown to users
  body_text    TEXT NOT NULL DEFAULT '' CHECK(length(body_text) <= 200),
  payload_key  TEXT,
  payload_type TEXT CHECK(payload_type IN ('zip', 'swf', 'gif', 'image')),
  click_url    TEXT CHECK(click_url NOT LIKE 'javascript:%'),
  active       INTEGER NOT NULL DEFAULT 0,
  impressions  INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ad_interactions (
  id          TEXT PRIMARY KEY,
  ad_id       TEXT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  duration_ms INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Global config (every_n and future settings)
CREATE TABLE ad_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO ad_config VALUES ('every_n', '5');
```

---

## API Endpoints

### Public (no auth required)

```
GET  /api/ads/active           # returns active ads in random order
POST /api/ads/:id/impression   # increment impression count
POST /api/ads/:id/click        # increment click count
POST /api/ads/:id/interaction  # { duration_ms: number }
```

### Admin only

```
GET    /api/admin/ads              # list all ads with stats
POST   /api/admin/ads              # create ad (multipart/form-data)
PATCH  /api/admin/ads/:id          # update fields or toggle active
DELETE /api/admin/ads/:id          # delete ad + R2 assets
GET    /api/admin/ads/config       # get global config (every_n etc.)
PATCH  /api/admin/ads/config       # { every_n: number }
```

---

## Timeline Injection

```typescript
// src/lib/inject-ads.ts
export function injectAds(
  posts: Post[],
  ads: Ad[],
  everyN: number
): (Post | Ad)[] {
  if (!ads.length) return posts
  const shuffled = [...ads].sort(() => Math.random() - 0.5)
  const result: (Post | Ad)[] = []
  let adIndex = 0
  posts.forEach((post, i) => {
    result.push(post)
    if ((i + 1) % everyN === 0) {
      result.push(shuffled[adIndex % shuffled.length])
      adIndex++
    }
  })
  return result
}
```

- `every_n` is a single global value fetched from `ad_config`
- Multiple active ads rotate randomly on each timeline render
- Zero active ads → posts returned as-is, no injection
- Applies to both authenticated and guest timelines

---

## Measurement — Client-side

All metrics are recorded by the browser calling the API directly. Ad blockers may cause measurement gaps; this is accepted for MVP.

```typescript
// Impression: fires once when AdCard is ≥50% visible
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      fetch(`/api/ads/${adId}/impression`, { method: 'POST' })
      observer.unobserve(entry.target)
    }
  })
}, { threshold: 0.5 })

// Click: fire-and-forget before navigating
function handleAdClick(adId: string, clickUrl: string) {
  fetch(`/api/ads/${adId}/click`, { method: 'POST' })  // not awaited
  window.open(clickUrl, '_blank', 'noopener')
}

// Interaction time: received via postMessage from sandbox iframe
window.addEventListener('message', (e) => {
  if (!e.origin.startsWith('blob:')) return
  if (e.data.type === 'AD_INTERACTION_END') {
    fetch(`/api/ads/${adId}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_ms: e.data.duration_ms })
    })
  }
})
```

---

## AdCard Component

```
┌──────────────────────────────────────┐
│                          Sponsored ↗ │  ← top-right, text-muted, font-mono
│ [body_text]                          │
│ ┌────────────────────────────────┐   │
│ │  AdStage (16:9)                │   │  ← shared sandbox renderer
│ │  ZIP / SWF / GIF / image       │   │
│ └────────────────────────────────┘   │
└──────────────────────────────────────┘
```

**Differences from PostCard**
- No avatar, username, tags, or timestamp
- No Fresh! / Reply / Share / `···` menu
- Entire card is clickable → opens `click_url` in new tab (`noopener`)
- SWF: click-to-play only, same as PostCard
- ZIP: self-contained, runs autonomously inside sandbox

**`Sponsored` label is mandatory** — required for compliance with Japanese Stealth Marketing regulations (景品表示法).

**iframe sandbox (NON-NEGOTIABLE — identical to PostCard)**
```html
<iframe
  sandbox="allow-scripts allow-forms allow-popups"
  allow="fullscreen; web-share"
  referrerpolicy="no-referrer"
/>
```
`allow-same-origin` is **permanently banned** on AdCard iframes.

---

## Admin UI — New `Ads` Tab at `/admin`

Adds a fourth tab to the existing Alerts / Hidden / Users layout.

```
Ads tab
├── Global settings row: every_n [number input] [Save]
├── [+ New Ad] button
└── Ad list table
    title | format | active (toggle) | impressions | clicks | CTR | Edit | Delete

Create / Edit modal
├── title (admin label)
├── body_text (≤200 chars, live counter)
├── payload upload (≤200MB, accepts .zip .swf .gif .png .jpg)
├── click_url
└── stats (edit mode only)
    impressions | clicks | CTR | avg interaction time
```

---

## Rate Limiting

Uses the shared `rate-limit.ts` utility. Always use `CF-Connecting-IP`.

| Endpoint | KV key | Limit |
|---|---|---|
| `POST /api/ads/:id/impression` | `ad-imp:{CF-Connecting-IP}` | 60 / min |
| `POST /api/ads/:id/click` | `ad-click:{CF-Connecting-IP}` | 20 / min |
| `POST /api/ads/:id/interaction` | `ad-int:{CF-Connecting-IP}` | 30 / min |

All `429` responses include a `Retry-After` header.

---

## Constraints (NON-NEGOTIABLE)

- `allow-same-origin` is permanently banned on any AdCard iframe
- `Sponsored` label must always be rendered — no exceptions
- `click_url` with `javascript:` scheme must be rejected at DB level and API level
- ZIP must be validated server-side before R2 write
- All sandbox / Ruffle / R2 / rate-limit logic must use shared modules — no duplication
- Ad management (create / edit / delete / config) is restricted to admin users only
- `every_n` is a single global value — per-ad frequency is not supported
- Client-side measurement gaps from ad blockers are accepted (known limitation)
