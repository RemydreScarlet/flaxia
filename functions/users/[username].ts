/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getSession, getSessionToken } from '../lib/auth'

type Bindings = {
  DB: D1Database
  BASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', cors())

// GET /users/:username - ActivityPub actor endpoint
app.get('/', async (c) => {
  try {
    const url = new URL(c.req.url)
    const username = url.pathname.split('/').pop() ?? ''
    const acceptHeader = c.req.header('Accept') || ''
    
    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, created_at 
      FROM users 
      WHERE username = ?
    `).bind(username).first()
    
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Check if this is an ActivityPub request
    if (acceptHeader.includes('application/activity+json')) {
      // Return ActivityPub actor object
      const actor: any = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Person',
        id: `${c.env.BASE_URL}/users/${username}`,
        preferredUsername: username,
        name: user.display_name,
        summary: user.bio || '',
        inbox: `${c.env.BASE_URL}/users/${username}/inbox`,
        outbox: `${c.env.BASE_URL}/users/${username}/outbox`
      }
      
      // Add icon if avatar exists
      if (user.avatar_key) {
        actor.icon = {
          type: 'Image',
          url: `${c.env.BASE_URL}/api/images/${user.avatar_key}`
        }
      }
      
      return c.json(actor, 200, {
        'Content-Type': 'application/activity+json'
      })
    }
    
    // For non-ActivityPub requests, redirect to the web profile page
    return c.redirect(`/users/${username}`)
  } catch (error: any) {
    console.error('Get user error:', error)
    return c.json({ error: 'Failed to get user', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /users/:username/inbox - ActivityPub inbox endpoint
app.post('/inbox', async (c) => {
  try {
    const contentType = c.req.header('content-type')
    if (!contentType?.includes('application/activity+json')) {
      return c.json({ error: 'Invalid content type' }, 400)
    }

    const url = new URL(c.req.url)
    const username = url.pathname.split('/users/')[1].split('/inbox')[0]
    
    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Get target user
    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .bind(username).first()
    
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }

    const activity = await c.req.json()
    const { type, actor, object } = activity

    // Handle different activity types
    switch (type) {
      case 'Follow': {
        if (!object || typeof object !== 'string') {
          return c.json({ error: 'Invalid object' }, 400)
        }

        // Extract username from object URL
        const objectUrl = new URL(object)
        const objectUsername = objectUrl.pathname.split('/users/')[1]
        if (!objectUsername || objectUsername !== username) {
          return c.json({ error: 'Object username mismatch' }, 400)
        }

        // Insert follow relationship
        await c.env.DB.prepare(
          'INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)'
        ).bind(actor, targetUser.id).run()

        return c.json({ ok: true }, 200)
      }

      case 'Undo': {
        if (!object || typeof object !== 'object' || object.type !== 'Follow') {
          return c.json({ error: 'Invalid undo object' }, 400)
        }

        // Delete follow relationship
        await c.env.DB.prepare(
          'DELETE FROM follows WHERE follower_id = ? AND followee_id = ?'
        ).bind(actor, targetUser.id).run()

        return c.json({ ok: true }, 200)
      }

      case 'Like':
      case 'Announce': {
        if (!object || typeof object !== 'string') {
          return c.json({ error: 'Invalid object' }, 400)
        }

        // Extract post ID from object URL
        const objectUrl = new URL(object)
        const postId = objectUrl.pathname.split('/posts/')[1]
        if (!postId) {
          return c.json({ error: 'Invalid post ID' }, 400)
        }

        // Check if post exists and increment fresh_count
        const post = await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?')
          .bind(postId).first()
        
        if (!post) {
          return c.json({ error: 'Post not found' }, 404)
        }

        await c.env.DB.prepare(
          'UPDATE posts SET fresh_count = fresh_count + 1 WHERE id = ?'
        ).bind(postId).run()

        return c.json({ ok: true }, 200)
      }

      default:
        // Ignore other activity types
        return c.json({ ok: true }, 200)
    }
  } catch (error: any) {
    console.error('Inbox error:', error)
    return c.json({ error: 'Inbox processing failed', details: error?.message || 'Unknown error' }, 500)
  }
})

export default app
