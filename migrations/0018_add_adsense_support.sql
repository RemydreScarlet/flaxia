-- Add AdSense support to ads table
ALTER TABLE ads ADD COLUMN ad_type TEXT DEFAULT 'self_hosted' CHECK(ad_type IN ('self_hosted', 'adsense'));
ALTER TABLE ads ADD COLUMN adsense_slot TEXT;
ALTER TABLE ads ADD COLUMN adsense_client TEXT DEFAULT 'ca-pub-8703789531673358';

-- Create index for ad_type queries
CREATE INDEX idx_ads_ad_type ON ads(ad_type);
