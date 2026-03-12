-- Migration: Reports overhaul with DMCA support, admin alerts, and hidden posts

-- Extend reports table
ALTER TABLE reports ADD COLUMN dmca_work_description TEXT;
ALTER TABLE reports ADD COLUMN dmca_reporter_email TEXT;
ALTER TABLE reports ADD COLUMN dmca_sworn INTEGER DEFAULT 0;
ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
-- status values: pending / warned / hidden / dismissed
-- Note: category CHECK constraint cannot be altered in SQLite — enforce in application layer

-- Add hidden flag to posts
ALTER TABLE posts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- New admin_alerts table
CREATE TABLE IF NOT EXISTS admin_alerts (
  id TEXT PRIMARY KEY,  -- nanoid
  post_id TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('critical', 'high', 'normal')),
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_unresolved ON admin_alerts(resolved, priority DESC, created_at DESC);
