-- Add actor_keys table for ActivityPub cryptographic keys
CREATE TABLE IF NOT EXISTS actor_keys (
  user_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_actor_keys_user_id ON actor_keys(user_id);
