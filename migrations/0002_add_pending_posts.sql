-- Add status column to posts table
ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'published';

-- Create index for pending posts
CREATE INDEX idx_posts_status ON posts(status);

-- Insert some test data
INSERT INTO posts (id, user_id, username, text, hashtags, status, created_at) VALUES
('demo-post-1', 'user-1', 'alice', 'Check out this interactive math demo: $E = mc^2$ and $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$', '["math", "physics"]', 'published', datetime('now', '-2 hours')),
('demo-post-2', 'user-2', 'bob', 'Just a simple text post #hello #world', '["hello", "world"]', 'published', datetime('now', '-1 hour')),
('demo-post-3', 'user-3', 'charlie', 'Another post with #hashtag and more text content', '["hashtag"]', 'published', datetime('now', '-30 minutes'));
