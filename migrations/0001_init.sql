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
