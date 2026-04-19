-- Add ad_type column to ads table
ALTER TABLE ads ADD COLUMN ad_type TEXT CHECK(ad_type IN ('self_hosted', 'admax')) DEFAULT 'self_hosted';

-- Add thumbnail_key column for ZIP/SWF ads
ALTER TABLE ads ADD COLUMN thumbnail_key TEXT;
