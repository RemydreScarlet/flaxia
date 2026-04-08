-- Add impressions column to posts table (if not exists)
ALTER TABLE posts ADD COLUMN impressions INTEGER NOT NULL DEFAULT 0;
