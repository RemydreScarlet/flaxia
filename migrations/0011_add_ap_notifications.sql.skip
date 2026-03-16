-- Migration: Add ActivityPub notification types
-- Update the CHECK constraint to include new ActivityPub notification types
-- SQLite doesn't support ALTER CONSTRAINT directly, so we need to recreate the table

BEGIN TRANSACTION;

-- Create new notifications table with updated constraint
CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('reported', 'fresh', 'warned', 'hidden', 'ap_follow', 'ap_like', 'ap_announce')),
  post_id    TEXT,
  actor_id   TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Copy data from old table
INSERT INTO notifications_new 
SELECT id, user_id, type, post_id, actor_id, read, created_at 
FROM notifications;

-- Drop old table
DROP TABLE notifications;

-- Rename new table
ALTER TABLE notifications_new RENAME TO notifications;

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, created_at DESC);

COMMIT;
