ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'
  CHECK(language IN ('en', 'ja'));
