-- Add thumbnail support to ads table
ALTER TABLE ads ADD COLUMN thumbnail_key TEXT;

-- Create index for faster thumbnail lookups
CREATE INDEX idx_ads_thumbnail_key ON ads(thumbnail_key);
