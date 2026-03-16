/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { generateKeyPair, exportPublicKey, exportPrivateKey } from '../../lib/activitypub/crypto'
import { buildNoteObject, buildCreateActivity } from '../../lib/activitypub/note'

type Bindings = {
  DB: D1Database
  BASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

// GET /actors/:username - ActivityPub Actor endpoint
app.get('/', async (c) => {
  try {
    // Extract username from URL path for Cloudflare Pages file-based routing
    const url = new URL(c.req.url)
    const pathParts = url.pathname.split('/')
    const username = pathParts[pathParts.indexOf('actors') + 1]
    
    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Check Accept header for ActivityPub content types
    const acceptHeader = c.req.header('Accept') || ''
    const isActivityPubRequest = acceptHeader.includes('application/activity+json') || 
                                acceptHeader.includes('application/ld+json')
    
    // Find user in database
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key 
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `).bind(username).first()
    
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Get or generate cryptographic keys for this user
    let keyRecord = await c.env.DB.prepare(`
      SELECT public_key_pem FROM actor_keys WHERE user_id = ?
    `).bind(user.id).first()

    let publicKeyPem: string
    if (!keyRecord) {
      // Generate new key pair
      const keyPair = await generateKeyPair()
      publicKeyPem = await exportPublicKey(keyPair.publicKey)
      const privateKeyPem = await exportPrivateKey(keyPair.privateKey)
      
      // Save to database
      await c.env.DB.prepare(`
        INSERT INTO actor_keys (user_id, public_key_pem, private_key_pem, created_at) 
        VALUES (?, ?, ?, datetime('now'))
      `).bind(user.id, publicKeyPem, privateKeyPem).run()
    } else {
      publicKeyPem = keyRecord.public_key_pem as string
    }
    
    // If not ActivityPub request, redirect to UI
    if (!isActivityPubRequest) {
      return c.redirect(`/profile/${username}`, 302)
    }
    
    // Return ActivityPub Actor object
    const actor: any = {
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "Person",
      "id": `${c.env.BASE_URL}/actors/${username}`,
      "preferredUsername": user.username,
      "name": user.display_name,
      "summary": user.bio || "",
      "inbox": `${c.env.BASE_URL}/actors/${username}/inbox`,
      "outbox": `${c.env.BASE_URL}/actors/${username}/outbox`,
      "followers": `${c.env.BASE_URL}/actors/${username}/followers`,
      "following": `${c.env.BASE_URL}/actors/${username}/following`,
      "publicKey": {
        "id": `${c.env.BASE_URL}/actors/${username}#main-key`,
        "owner": `${c.env.BASE_URL}/actors/${username}`,
        "publicKeyPem": publicKeyPem
      }
    }
    
    // Add icon if avatar is available
    if (user.avatar_key) {
      actor.icon = {
        "type": "Image",
        "mediaType": "image/jpeg",
        "url": `${c.env.BASE_URL}/api/images/${user.avatar_key}`
      }
    }
    
    return c.json(actor, 200, {
      'Content-Type': 'application/activity+json'
    })
  } catch (error: any) {
    console.error('Actor endpoint error:', error)
    return c.json({ error: 'Actor endpoint failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /actors/:username/outbox - ActivityPub Outbox endpoint
app.get('/outbox', async (c) => {
  try {
    const url = new URL(c.req.url)
    const pathParts = url.pathname.split('/')
    const username = pathParts[pathParts.indexOf('actors') + 1]

    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Check Accept header for ActivityPub content types
    const acceptHeader = c.req.header('Accept') || ''
    const isActivityPubRequest = acceptHeader.includes('application/activity+json') || 
                                acceptHeader.includes('application/ld+json')

    // Find user in database
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name FROM users 
      WHERE username = ? COLLATE NOCASE
    `).bind(username).first() as { id: string, username: string, display_name: string } | null

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Get recent posts (last 20)
    const posts = await c.env.DB.prepare(`
      SELECT id, text, created_at, visibility FROM posts
      WHERE user_id = ? AND status = 'published' AND visibility = 'public'
      ORDER BY created_at DESC LIMIT 20
    `).bind(user.id).all() as { results: Array<{ id: string, text: string, created_at: string, visibility: string }> }

    // Build activities from posts
    const activities = posts.results.map(post => {
      const note = buildNoteObject(post, user, c.env.BASE_URL)
      return buildCreateActivity(note, user, c.env.BASE_URL)
    })

    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/actors/${username}/outbox`,
      "totalItems": activities.length,
      "orderedItems": activities
    }, 200, { 'Content-Type': 'application/activity+json' })
  } catch (error: any) {
    console.error('Outbox endpoint error:', error)
    return c.json({ error: 'Outbox endpoint failed', details: error?.message || 'Unknown error' }, 500)
  }
})

export default app
