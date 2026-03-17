/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { verifyHttpSignature, verifyDigest, fetchActorPublicKey } from '../../../lib/activitypub/signature'

type Bindings = {
  DB: D1Database
  BASE_URL: string
  AP_DELIVERY_QUEUE: Queue
}

interface InboxMessage {
  type: 'inbox'
  username: string
  activity: object
  actorId: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.post('/', async (c) => {
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

    const contentType = c.req.header('Content-Type') || ''
    if (!contentType.includes('application/activity+json') && !contentType.includes('application/json')) {
      return c.json({ error: 'Content-Type must be application/activity+json' }, 400)
    }

    const body = await c.req.text()

    let activity: any
    try {
      activity = JSON.parse(body)
    } catch (e) {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!activity.type) {
      return c.json({ error: 'Activity must have a type' }, 400)
    }

    const validTypes = ['Create', 'Follow', 'Accept', 'Like', 'Announce', 'Delete', 'Undo']
    if (!validTypes.includes(activity.type)) {
      return c.json({ error: `Unsupported activity type: ${activity.type}` }, 400)
    }

    const user = await c.env.DB.prepare(`
      SELECT id, username FROM users WHERE username = ? COLLATE NOCASE
    `).bind(username).first() as { id: string, username: string } | null

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    const actorId = activity.actor
    if (!actorId) {
      return c.json({ error: 'Activity must have an actor' }, 400)
    }

    const publicKeyPem = await fetchActorPublicKey(actorId)
    if (!publicKeyPem) {
      console.error('Could not fetch public key for actor:', actorId)
      return c.json({ error: 'Could not verify actor' }, 401)
    }

    const signatureValid = await verifyHttpSignature(c.req.raw, publicKeyPem)
    if (!signatureValid) {
      console.error('HTTP signature verification failed for actor:', actorId)
      return c.json({ error: 'Signature verification failed' }, 401)
    }

    const digestValid = await verifyDigest(c.req.raw, body)
    if (!digestValid) {
      console.error('Digest verification failed')
      return c.json({ error: 'Digest verification failed' }, 401)
    }

    const message: InboxMessage = {
      type: 'inbox',
      username: username,
      activity: activity,
      actorId: actorId
    }

    await c.env.AP_DELIVERY_QUEUE.send(message)

    return new Response(null, { status: 202 })
  } catch (error: any) {
    console.error('Inbox endpoint error:', error)
    return c.json({ error: 'Inbox processing failed', details: error?.message || 'Unknown error' }, 500)
  }
})

app.get('/', async (c) => {
  const url = new URL(c.req.url)
  const pathParts = url.pathname.split('/')
  const username = pathParts[pathParts.indexOf('actors') + 1]

  if (!username) {
    return c.json({ error: 'Username required' }, 400)
  }

  const acceptHeader = c.req.header('Accept') || ''
  const isActivityPubRequest = acceptHeader.includes('application/activity+json') || 
                              acceptHeader.includes('application/ld+json')

  if (!isActivityPubRequest) {
    return c.redirect(`/profile/${username}`, 302)
  }

  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'OrderedCollection',
    id: `${c.env.BASE_URL}/actors/${username}/inbox`,
    totalItems: 0,
    orderedItems: []
  }, 200, { 'Content-Type': 'application/activity+json' })
})

export default app
