import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  BUCKET: R2Bucket
  SANDBOX_ORIGIN: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', cors())

// GET /api/posts - timeline
app.get('/posts', async (c) => {
  const cursor = c.req.query('cursor')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  
  let query = 'SELECT * FROM posts ORDER BY created_at DESC LIMIT ?'
  const params = [limit]
  
  if (cursor) {
    query = 'SELECT * FROM posts WHERE created_at < ? ORDER BY created_at DESC LIMIT ?'
    params.unshift(cursor)
  }
  
  const posts = await c.env.DB.prepare(query).bind(...params).all()
  return c.json(posts.results)
})

// POST /api/posts - create post
app.post('/posts', async (c) => {
  const formData = await c.req.formData()
  const text = formData.get('text') as string
  const username = formData.get('username') as string
  
  if (!text || !username || text.length > 200) {
    return c.json({ error: 'Invalid text or username' }, 400)
  }
  
  const postId = crypto.randomUUID()
  
  const result = await c.env.DB.prepare(`
    INSERT INTO posts (id, user_id, username, text, hashtags)
    VALUES (?, ?, ?, ?, ?)
  `).bind(postId, c.get('user').sub, username, text, '[]').run()
  
  if (!result.success) {
    return c.json({ error: 'Failed to create post' }, 500)
  }
  
  return c.json({ id: postId })
})

// POST /api/posts/:id/fresh - toggle Fresh!
app.post('/posts/:id/fresh', async (c) => {
  const postId = c.req.param('id')
  const userId = c.get('user').sub
  
  // Check if already freshed
  const existing = await c.env.DB.prepare(
    'SELECT * FROM freshs WHERE post_id = ? AND user_id = ?'
  ).bind(postId, userId).first()
  
  if (existing) {
    // Remove fresh
    await c.env.DB.prepare(
      'DELETE FROM freshs WHERE post_id = ? AND user_id = ?'
    ).bind(postId, userId).run()
    
    await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count - 1 WHERE id = ?'
    ).bind(postId).run()
    
    return c.json({ freshed: false })
  } else {
    // Add fresh
    await c.env.DB.prepare(
      'INSERT INTO freshs (post_id, user_id) VALUES (?, ?)'
    ).bind(postId, userId).run()
    
    await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count + 1 WHERE id = ?'
    ).bind(postId).run()
    
    return c.json({ freshed: true })
  }
})

export default app
