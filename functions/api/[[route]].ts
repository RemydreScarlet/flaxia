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

app.use('/*', cors())

// PUT /api/upload/:key - direct file upload endpoint (no auth required - validated in prepare step)
app.put('/api/upload/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/upload/', '')
    const contentType = c.req.header('content-type')
    const contentLength = c.req.header('content-length')
    
    if (!key) {
      return c.json({ error: 'Missing file key' }, 400)
    }
    
    // Check file size limit (10MB = 10 * 1024 * 1024 bytes)
    const maxSize = 10 * 1024 * 1024
    if (contentLength && Number(contentLength) > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 10MB' }, 413)
    }
    
    // Get the file data from request body
    const fileData = await c.req.arrayBuffer()
    
    // Double-check file size after reading
    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 10MB' }, 413)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Upload to R2 with proper content type
    await c.env.BUCKET.put(key, fileData, {
      httpMetadata: {
        contentType: contentType || 'application/octet-stream'
      }
    })
    
    return c.json({ success: true, key })
  } catch (error: any) {
    console.error('Upload error:', error)
    return c.json({ error: 'Upload failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/images/* - proxy images from R2
// GET /api/audio/* - proxy audio files from R2  
app.get('/api/images/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/images/', '')
    
    if (!key) {
      return c.json({ error: 'Missing image key' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Get object from R2
    const object = await c.env.BUCKET.get(key)
    
    if (!object) {
      return c.json({ error: 'Image not found' }, 404)
    }
    
    // Get content type from object metadata or default to image/jpeg
    const contentType = object.httpMetadata?.contentType || 'image/jpeg'
    
    // Return the image with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('Image proxy error:', error)
    return c.json({ error: 'Failed to fetch image', details: error?.message || 'Unknown error' }, 500)
  }
})

app.get('/api/audio/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/audio/', '')
    
    if (!key) {
      return c.json({ error: 'Missing audio key' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Get object from R2
    const object = await c.env.BUCKET.get(key)
    
    if (!object) {
      return c.json({ error: 'Audio not found' }, 404)
    }
    
    // Get content type from object metadata or default to audio/mpeg
    const contentType = object.httpMetadata?.contentType || 'audio/mpeg'
    
    // Return the audio with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('Audio proxy error:', error)
    return c.json({ error: 'Failed to fetch audio', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/zip/:postId - serve ZIP files from R2
app.get('/api/zip/:postId', async (c) => {
  try {
    const postId = c.req.param('postId')
    
    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Construct the ZIP key
    const zipKey = `zip/${postId}.zip`
    
    // Get object from R2
    const object = await c.env.BUCKET.get(zipKey)
    
    if (!object) {
      return c.json({ error: 'ZIP not found' }, 404)
    }
    
    // Return the ZIP with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/zip',
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('ZIP proxy error:', error)
    return c.json({ error: 'Failed to fetch ZIP', details: error?.message || 'Unknown error' }, 500)
  }
})

// Auth middleware - only for API routes
app.use('/api/*', async (c, next) => {
  // Skip auth for GET /api/me, PUT /api/upload/*, GET /api/images/*, GET /api/audio/*, and GET /api/zip/*
  if ((c.req.method === 'GET' && c.req.path === '/api/me') || 
      (c.req.method === 'PUT' && c.req.path.startsWith('/api/upload/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/images/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/audio/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/zip/'))) {
    await next()
    return
  }
  
  const identity = await verifyCloudflareAccess(c.req, c.env)
  if (!identity) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.set('user', identity)
  await next()
})

app.use('/*', cors())

// GET /api/me - check auth state
app.get('/api/me', async (c) => {
  try {
    const identity = await verifyCloudflareAccess(c.req, c.env)
    if (!identity) {
      return c.json({ error: 'Not authenticated' }, 401)
    }
    
    return c.json({ 
      sub: identity.sub, 
      email: identity.email 
    })
  } catch (error: any) {
    console.error('Auth check error:', error)
    return c.json({ error: 'Auth check failed' }, 500)
  }
})

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
    
    let query = 'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE status = \'published\' AND parent_id IS NULL ORDER BY created_at DESC LIMIT ?'
    const params: any[] = [limit]
    
    if (cursor) {
      query = 'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE status = \'published\' AND parent_id IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?'
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

// Step 1 — POST /api/posts/prepare
app.post('/api/posts/prepare', async (c) => {
  try {
    const { filename, contentType } = await c.req.json()
    
    if (!filename || !contentType) {
      return c.json({ error: 'Missing filename or contentType' }, 400)
    }
    
    const allowedTypes = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm', 'application/zip']
    if (!allowedTypes.includes(contentType)) {
      return c.json({ error: 'Only image files (GIF, PNG, JPG), audio files (MP3, WAV, OGG, M4A, WebM), and ZIP files are supported' }, 400)
    }
    
    const postId = crypto.randomUUID()
    let fileExtension: string
    let storageKey: string
    
    if (contentType.startsWith('image/')) {
      fileExtension = contentType === 'image/png' ? '.png' : contentType === 'image/jpeg' || contentType === 'image/jpg' ? '.jpg' : '.gif'
      storageKey = `gif/${postId}${fileExtension}`
    } else if (contentType.startsWith('audio/')) {
      fileExtension = contentType === 'audio/mpeg' ? '.mp3' : 
                     contentType === 'audio/wav' ? '.wav' : 
                     contentType === 'audio/ogg' ? '.ogg' : 
                     contentType === 'audio/mp4' ? '.m4a' : '.webm'
      storageKey = `audio/${postId}${fileExtension}`
    } else if (contentType === 'application/zip') {
      storageKey = `zip/${postId}.zip`
    } else {
      return c.json({ error: 'Unsupported file type' }, 400)
    }
    
    const gifKey = storageKey
    
    // Store pending record in D1
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, ${contentType === 'application/zip' ? 'payload_key' : 'gif_key'}, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).bind(postId, c.get('user').sub, c.get('user').email?.split('@')[0] || 'anonymous', '', '[]', gifKey).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to create pending post' }, 500)
    }
    
    // Return upload endpoint URL (our own API)
    if (contentType === 'application/zip') {
      const zipUploadUrl = `${new URL(c.req.url).origin}/api/upload/${gifKey}`
      return c.json({
        postId,
        zipUploadUrl,
        zipKey: gifKey
      })
    } else {
      const gifUploadUrl = `${new URL(c.req.url).origin}/api/upload/${gifKey}`
      return c.json({
        postId,
        gifUploadUrl,
        gifKey
      })
    }
  } catch (error: any) {
    console.error('Prepare post error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// Step 3 — POST /api/posts/commit
app.post('/api/posts/commit', async (c) => {
  try {
    const { postId, gifKey, zipKey, text, hashtags } = await c.req.json()
    
    // Validate text
    if (!text || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422)
    }
    
    // Validate hashtags
    if (!Array.isArray(hashtags) || hashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422)
    }
    
    for (const tag of hashtags) {
      if (typeof tag !== 'string' || tag.length > 20 || !/^[a-zA-Z0-9_]+$/.test(tag)) {
        return c.json({ error: 'Hashtags must be alphanumeric and ≤20 chars' }, 422)
      }
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    let post: any
    
    if (gifKey || zipKey) {
      const key = zipKey || gifKey
      // Validate that this is a pending post and key matches
      const pendingPost = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ? AND status = 'pending' AND (gif_key = ? OR payload_key = ?)
      `).bind(postId, key, key).first()
      
      if (!pendingPost) {
        return c.json({ error: 'Invalid or expired post preparation' }, 422)
      }
      
      // Check if file exists in R2 (simplified check for now)
      // In production, this would be: await c.env.BUCKET.head(key)
      const fileExists = true // Placeholder - implement actual R2 check
      
      if (!fileExists) {
        return c.json({ error: 'File not uploaded' }, 422)
      }
      
      // Update post to published status
      const updateResult = await c.env.DB.prepare(`
        UPDATE posts 
        SET text = ?, hashtags = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).bind(text, JSON.stringify(hashtags), postId).run()
      
      if (!updateResult.success) {
        return c.json({ error: 'Failed to commit post' }, 500)
      }
      
      // Return the updated post
      post = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ?
      `).bind(postId).first()
    } else {
      // Create text-only post directly
      const result = await c.env.DB.prepare(`
        INSERT INTO posts (id, user_id, username, text, hashtags, status)
        VALUES (?, ?, ?, ?, ?, 'published')
      `).bind(postId, c.get('user').sub, c.get('user').email?.split('@')[0] || 'anonymous', text, JSON.stringify(hashtags)).run()
      
      if (!result.success) {
        return c.json({ error: 'Failed to create post' }, 500)
      }
      
      // Return the created post
      post = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ?
      `).bind(postId).first()
    }
    
    return c.json({ post })
  } catch (error: any) {
    console.error('Commit post error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
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

// GET /api/posts/:id/replies - get direct replies
app.get('/api/posts/:id/replies', async (c) => {
  try {
    const postId = c.req.param('id')
    const cursor = c.req.query('cursor')
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Verify parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first()
    
    if (!parentPost) {
      return c.json({ error: 'Post not found' }, 404)
    }
    
    let query = 'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE parent_id = ? AND status = \'published\' ORDER BY created_at ASC LIMIT ?'
    const params: any[] = [postId, limit]
    
    if (cursor) {
      query = 'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE parent_id = ? AND status = \'published\' AND created_at > ? ORDER BY created_at ASC LIMIT ?'
      params.splice(1, 0, cursor)
    }
    
    const result = await c.env.DB.prepare(query).bind(...params).all()
    
    if (!result.success) {
      return c.json({ error: 'Failed to fetch replies' }, 500)
    }
    
    const replies = result.results || []
    const nextCursor = replies.length === limit ? replies[replies.length - 1].created_at : null
    
    return c.json({ replies, nextCursor })
  } catch (error: any) {
    console.error('Replies fetch error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /api/posts/:id/thread - get full thread
app.get('/api/posts/:id/thread', async (c) => {
  try {
    const postId = c.req.param('id')
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // First get the post to find root_id
    const post = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first()
    
    if (!post) {
      return c.json({ error: 'Post not found' }, 404)
    }
    
    const rootId = post.root_id || post.id
    
    // Get root post
    const rootPost = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(rootId).first()
    
    if (!rootPost) {
      return c.json({ error: 'Thread not found' }, 404)
    }
    
    // Get all replies in thread (max 200 for MVP)
    const repliesResult = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE root_id = ? AND status = \'published\' AND id != ? ORDER BY created_at ASC LIMIT 200'
    ).bind(rootId, rootId).all()
    
    if (!repliesResult.success) {
      return c.json({ error: 'Failed to fetch thread' }, 500)
    }
    
    return c.json({ root: rootPost, replies: repliesResult.results || [] })
  } catch (error: any) {
    console.error('Thread fetch error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Step 1 — POST /api/posts/:id/replies/prepare
app.post('/api/posts/:id/replies/prepare', async (c) => {
  try {
    const postId = c.req.param('id')
    const { filename, contentType } = await c.req.json()
    
    if (!filename || !contentType) {
      return c.json({ error: 'Missing filename or contentType' }, 400)
    }
    
    const allowedTypes = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm']
    if (!allowedTypes.includes(contentType)) {
      return c.json({ error: 'Only image files (GIF, PNG, JPG) and audio files (MP3, WAV, OGG, M4A, WebM) are supported' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Validate parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first()
    
    if (!parentPost) {
      return c.json({ error: 'Parent post not found' }, 404)
    }
    
    const replyId = crypto.randomUUID()
    let fileExtension: string
    let storageKey: string
    
    if (contentType.startsWith('image/')) {
      fileExtension = contentType === 'image/png' ? '.png' : contentType === 'image/jpeg' || contentType === 'image/jpg' ? '.jpg' : '.gif'
      storageKey = `gif/${replyId}${fileExtension}`
    } else if (contentType.startsWith('audio/')) {
      fileExtension = contentType === 'audio/mpeg' ? '.mp3' : 
                     contentType === 'audio/wav' ? '.wav' : 
                     contentType === 'audio/ogg' ? '.ogg' : 
                     contentType === 'audio/mp4' ? '.m4a' : '.webm'
      storageKey = `audio/${replyId}${fileExtension}`
    } else {
      return c.json({ error: 'Unsupported file type' }, 400)
    }
    
    const gifKey = storageKey
    
    // Compute depth and root_id
    const depth = Math.min(Number(parentPost.depth || 0) + 1, 5)
    const rootId = parentPost.root_id || parentPost.id
    
    // Store pending reply in D1
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, gif_key, status, parent_id, root_id, depth, reply_count)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0)
    `).bind(
      replyId, 
      c.get('user').sub, 
      c.get('user').email?.split('@')[0] || 'anonymous', 
      '', 
      '[]', 
      gifKey,
      postId,
      rootId,
      depth
    ).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to create pending reply' }, 500)
    }
    
    // Generate upload endpoint URL (our own API)
    const gifUploadUrl = `${new URL(c.req.url).origin}/api/upload/${gifKey}`
    
    return c.json({
      replyId,
      gifUploadUrl,
      gifKey
    })
  } catch (error: any) {
    console.error('Prepare reply error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Step 3 — POST /api/posts/:id/replies/commit
app.post('/api/posts/:id/replies/commit', async (c) => {
  try {
    const postId = c.req.param('id')
    const { replyId, gifKey, text, hashtags } = await c.req.json()
    
    // Validate text
    if (!text || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422)
    }
    
    // Validate hashtags
    if (!Array.isArray(hashtags) || hashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422)
    }
    
    for (const tag of hashtags) {
      if (typeof tag !== 'string' || tag.length > 20 || !/^[a-zA-Z0-9_]+$/.test(tag)) {
        return c.json({ error: 'Hashtags must be alphanumeric and ≤20 chars' }, 422)
      }
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Validate parent still exists and is published
    const parentPost = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first()
    
    if (!parentPost) {
      return c.json({ error: 'Parent post no longer available' }, 422)
    }
    
    let reply: any
    
    if (gifKey) {
      // Validate that this is a pending reply and gifKey matches
      const pendingReply = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ? AND status = 'pending' AND gif_key = ? AND parent_id = ?
      `).bind(replyId, gifKey, postId).first()
      
      if (!pendingReply) {
        return c.json({ error: 'Invalid or expired reply preparation' }, 422)
      }
      
      // Check if GIF exists in R2 (simplified check for now)
      const gifExists = true // Placeholder - implement actual R2 check
      
      if (!gifExists) {
        return c.json({ error: 'GIF not uploaded' }, 422)
      }
      
      // Update reply to published status
      const updateResult = await c.env.DB.prepare(`
        UPDATE posts 
        SET text = ?, hashtags = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).bind(text, JSON.stringify(hashtags), replyId).run()
      
      if (!updateResult.success) {
        return c.json({ error: 'Failed to commit reply' }, 500)
      }
      
      // Return the updated reply
      reply = await c.env.DB.prepare(`
        SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ?
      `).bind(replyId).first()
    } else {
      // Create text-only reply directly
      const depth = Math.min(Number(parentPost.depth || 0) + 1, 5)
      const rootId = parentPost.root_id || parentPost.id
      
      const result = await c.env.DB.prepare(`
        INSERT INTO posts (id, user_id, username, text, hashtags, status, parent_id, root_id, depth, reply_count)
        VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, 0)
      `).bind(
        replyId, 
        c.get('user').sub, 
        c.get('user').email?.split('@')[0] || 'anonymous', 
        text, 
        JSON.stringify(hashtags),
        postId,
        rootId,
        depth
      ).run()
      
      if (!result.success) {
        return c.json({ error: 'Failed to create reply' }, 500)
      }
      
      // Return the created reply
      reply = await c.env.DB.prepare(`
        SELECT id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ?
      `).bind(replyId).first()
    }
    
    // Increment parent's reply count
    await c.env.DB.prepare(`
      UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?
    `).bind(postId).run()
    
    return c.json({ reply })
  } catch (error: any) {
    console.error('Commit reply error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Export for Cloudflare Pages Functions
export async function onRequest(context: any) {
  return app.fetch(context.request, context.env, context)
}
