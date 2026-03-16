-- Add ActivityPub followers table for tracking remote followers
CREATE TABLE IF NOT EXISTS ap_followers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  local_user_id TEXT NOT NULL,
  actor_url TEXT NOT NULL,
  inbox_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (local_user_id) REFERENCES users (id) ON DELETE CASCADE,
  UNIQUE (local_user_id, actor_url)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_ap_followers_local_user_id ON ap_followers(local_user_id);
