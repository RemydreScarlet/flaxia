-- Migration: Fix reports table schema mismatch
-- Remove the old 'reason' column since 'category' already exists

-- Drop the old reason column since category already exists
ALTER TABLE reports DROP COLUMN reason;
