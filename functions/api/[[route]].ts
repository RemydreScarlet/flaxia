import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { verifyCloudflareAccess } from '../lib/auth.js'

type Bindings = {
  DB: D1Database
  BUCKET: R2Bucket
  SANDBOX_ORIGIN: string
}

type Variables = {
  user: {
    sub: string
    email?: string
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// Auth middleware
app.use('/api/*', async (c, next) => {
  const identity = await verifyCloudflareAccess(c.req, c.env)
  if (!identity) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.set('user', identity)
  await next()
})

app.use('/*', cors())

// GET /api/posts - timeline
app.get('/api/posts', async (c) => {
  try {
    const cursor = c.req.query('cursor')
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    
    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available')
      return c.json({ error: 'Database not available' }, 500)
    }
    
    let query = 'SELECT * FROM posts ORDER BY created_at DESC LIMIT ?'
    const params: any[] = [limit]
    
    if (cursor) {
      query = 'SELECT * FROM posts WHERE created_at < ? ORDER BY created_at DESC LIMIT ?'
      params.unshift(cursor)
    }
    
    const result = await c.env.DB.prepare(query).bind(...params).all()
    
    if (!result.success) {
      console.error('Database query failed:', result)
      return c.json({ error: 'Failed to fetch posts' }, 500)
    }
    
    return c.json({ posts: result.results || [] })
  } catch (error: any) {
    console.error('Posts fetch error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/upload/presigned - get presigned URL for file upload
app.post('/api/upload/presigned', async (c) => {
  const { filename, contentType, size } = await c.req.json()
  
  if (!filename || !contentType || !size) {
    return c.json({ error: 'Missing required fields' }, 400)
  }
  
  if (size > 10 * 1024 * 1024) { // 10MB limit
    return c.json({ error: 'File too large' }, 400)
  }
  
  const postId = crypto.randomUUID()
  const fileExtension = filename.split('.').pop()
  const key = `payload/${postId}.${fileExtension}`
  
  // For now, return a simple upload URL - in production this would be a proper presigned URL
  const uploadUrl = `/api/upload/direct`
  
  return c.json({
    uploadUrl,
    key,
    postId
  })
})

// POST /api/posts - create post
app.post('/api/posts', async (c) => {
  try {
    const { text, payloadKey, gifKey } = await c.req.json()
    
    if (!text || text.length > 200) {
      return c.json({ error: 'Invalid text' }, 400)
    }
    
    const postId = crypto.randomUUID()
    const userId = c.get('user').sub
    const username = c.get('user').email?.split('@')[0] || 'anonymous'
    
    // Extract hashtags from text
    const hashtagRegex = /#(\w+)/g
    const hashtags = Array.from(text.matchAll(hashtagRegex), (m: RegExpMatchArray) => m[1])
    
    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available')
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, payload_key, gif_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(postId, userId, username, text, JSON.stringify(hashtags), payloadKey || null, gifKey || null).run()
    
    if (!result.success) {
      console.error('Database insert failed:', result)
      return c.json({ error: 'Failed to create post', details: result }, 500)
    }
    
    return c.json({ id: postId })
  } catch (error: any) {
    console.error('Post creation error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/posts/:id/fresh - toggle Fresh!
app.post('/api/posts/:id/fresh', async (c) => {
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

// Export for Cloudflare Pages Functions
export async function onRequest(context: any) {
  return app.fetch(context.request, context.env, context)
}
