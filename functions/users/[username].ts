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

export default app
