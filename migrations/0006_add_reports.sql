-- Migration: Add reports table for post reporting system
CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK(reason IN ('spam','harassment','inappropriate','misinformation','other')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (post_id, user_id)
);
