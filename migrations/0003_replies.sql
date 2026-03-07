-- Add reply support to posts table
ALTER TABLE posts ADD COLUMN parent_id   TEXT REFERENCES posts(id);
ALTER TABLE posts ADD COLUMN root_id     TEXT REFERENCES posts(id);
ALTER TABLE posts ADD COLUMN depth       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;

-- Create indexes for reply queries
CREATE INDEX idx_posts_parent   ON posts(parent_id, created_at ASC);
CREATE INDEX idx_posts_root     ON posts(root_id,   created_at ASC);

-- Update timeline index to exclude replies from main feed
DROP INDEX IF EXISTS idx_posts_timeline;
CREATE INDEX idx_posts_timeline ON posts(status, parent_id, created_at DESC) WHERE parent_id IS NULL;
