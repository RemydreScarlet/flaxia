/// <reference types="@cloudflare/workers-types" />

interface DeliveryMessage {
  type: 'delivery'
  inboxUrl: string
  activity: object
  senderUsername: string
}

interface InboxMessage {
  type: 'inbox'
  username: string
  activity: object
  actorId: string
}

type QueueMessage = DeliveryMessage | InboxMessage

interface Env {
  DB: D1Database
  BASE_URL: string
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (message.body.type === 'inbox') {
        await handleInboxActivity(message.body, env, message)
      } else {
        await handleDeliveryActivity(message.body, env, message)
      }
    }
  }
}

async function handleDeliveryActivity(msg: DeliveryMessage, env: Env, message: any): Promise<void> {
  const { inboxUrl, activity, senderUsername } = msg

  try {
    const keyResult = await env.DB.prepare(`
      SELECT ak.private_key_pem FROM actor_keys ak
      JOIN users u ON u.id = ak.user_id
      WHERE u.username = ?
    `).bind(senderUsername).first()

    if (!keyResult || !keyResult.private_key_pem) {
      console.error('No private key found for user:', senderUsername)
      message.ack()
      return
    }

    const privateKeyPem = keyResult.private_key_pem as string
    const keyId = `${env.BASE_URL}/actors/${senderUsername}#main-key`

    const { signRequest } = await import('./lib/activitypub/signature')
    const body = JSON.stringify(activity)
    const headers = await signRequest(inboxUrl, body, privateKeyPem, keyId)

    const response = await fetch(inboxUrl, {
      method: 'POST',
      headers: headers,
      body: body
    })

    if (!response.ok) {
      console.error('Delivery failed:', inboxUrl, 'status:', response.status)
    }

    message.ack()
  } catch (e) {
    console.error('Delivery error:', inboxUrl, e)
    message.retry()
  }
}

async function handleInboxActivity(msg: InboxMessage, env: Env, message: any): Promise<void> {
  const { username, activity, actorId } = msg

  try {
    const activityType = (activity as any).type

    switch (activityType) {
      case 'Create':
        await handleCreateActivity(activity, username, actorId, env)
        break
      case 'Follow':
        await handleFollowActivity(activity, username, actorId, env)
        break
      case 'Accept':
        await handleAcceptActivity(activity, username, actorId, env)
        break
      case 'Like':
        await handleLikeActivity(activity, username, actorId, env)
        break
      case 'Announce':
        await handleAnnounceActivity(activity, username, actorId, env)
        break
      case 'Delete':
        await handleDeleteActivity(activity, username, actorId, env)
        break
      case 'Undo':
        await handleUndoActivity(activity, username, actorId, env)
        break
      default:
        console.warn('Unknown activity type:', activityType)
    }

    message.ack()
  } catch (e) {
    console.error('Inbox processing error:', e)
    message.retry()
  }
}

async function handleCreateActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  if (!object || object.type !== 'Note') {
    console.log('Ignoring Create activity with non-Note object')
    return
  }

  const content = object.content
  if (!content || typeof content !== 'string') {
    console.error('Note missing content')
    return
  }

  if (content.length > 200) {
    console.error('Note content too long:', content.length)
    return
  }

  const userResult = await env.DB.prepare(`
    SELECT id FROM users WHERE username = ? COLLATE NOCASE
  `).bind(username).first() as { id: string } | null

  if (!userResult) {
    console.error('User not found:', username)
    return
  }

  const userId = userResult.id
  const postId = activity.id ? activity.id.split('/create-')[1] : generatePostId()

  const hashtags: string[] = []
  const hashtagRegex = /#(\w+)/g
  let match
  while ((match = hashtagRegex.exec(content)) !== null) {
    hashtags.push(match[1])
  }

  let parentId: string | null = null
  let rootId: string | null = null
  let depth = 0

  if (object.inReplyTo) {
    const replyTo = object.inReplyTo
    const postIdMatch = replyTo.match(/\/notes\/([a-zA-Z0-9]+)/)
    if (postIdMatch) {
      parentId = postIdMatch[1]
    }
  }

  await env.DB.prepare(`
    INSERT INTO posts (id, user_id, username, text, hashtags, status, parent_id, root_id, depth, created_at)
    VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, datetime('now'))
  `).bind(postId, userId, username, content, JSON.stringify(hashtags), parentId, rootId, depth).run()

  console.log('Note received and stored:', postId)
}

async function handleFollowActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const userResult = await env.DB.prepare(`
    SELECT id FROM users WHERE username = ? COLLATE NOCASE
  `).bind(username).first() as { id: string } | null

  if (!userResult) {
    console.error('User not found:', username)
    return
  }

  const localUserId = userResult.id

  const existingFollow = await env.DB.prepare(`
    SELECT id FROM ap_followers WHERE local_user_id = ? AND actor_url = ?
  `).bind(localUserId, actorId).first()

  if (existingFollow) {
    console.log('Follower already exists:', actorId)
    return
  }

  const followerId = generateId()
  await env.DB.prepare(`
    INSERT INTO ap_followers (id, local_user_id, actor_url, inbox_url, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(followerId, localUserId, actorId, activity.actor).run()

  console.log('Follow request recorded:', actorId)
}

async function handleAcceptActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  if (!object || object.type !== 'Follow') {
    console.log('Ignoring Accept for non-Follow activity')
    return
  }

  const followActor = object.actor
  if (!followActor) {
    console.error('Accept activity missing object actor')
    return
  }

  console.log('Follow accepted from:', followActor)
}

async function handleLikeActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  const objectUrl = object?.id || object
  if (!objectUrl) {
    console.error('Like activity missing object')
    return
  }

  const postIdMatch = objectUrl.match(/\/notes\/([a-zA-Z0-9]+)/)
  if (!postIdMatch) {
    console.log('Like target is not a local post:', objectUrl)
    return
  }

  const postId = postIdMatch[1]

  const postResult = await env.DB.prepare(`
    SELECT id FROM posts WHERE id = ?
  `).bind(postId).first()

  if (!postResult) {
    console.log('Liked post not found:', postId)
    return
  }

  const existingLike = await env.DB.prepare(`
    SELECT id FROM likes WHERE post_id = ? AND actor_id = ?
  `).bind(postId, actorId).first()

  if (existingLike) {
    console.log('Like already exists:', postId, actorId)
    return
  }

  const likeId = generateId()
  await env.DB.prepare(`
    INSERT INTO likes (id, post_id, user_id, actor_id, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(likeId, postId, 'unknown', actorId).run()

  console.log('Like recorded:', postId, actorId)
}

async function handleAnnounceActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  const objectUrl = object?.id || object
  if (!objectUrl) {
    console.error('Announce activity missing object')
    return
  }

  const postIdMatch = objectUrl.match(/\/notes\/([a-zA-Z0-9]+)/)
  if (!postIdMatch) {
    console.log('Announce target is not a local post:', objectUrl)
    return
  }

  const postId = postIdMatch[1]

  const postResult = await env.DB.prepare(`
    SELECT id FROM posts WHERE id = ?
  `).bind(postId).first()

  if (!postResult) {
    console.log('Announced post not found:', postId)
    return
  }

  const existingShare = await env.DB.prepare(`
    SELECT id FROM shares WHERE post_id = ? AND actor_id = ?
  `).bind(postId, actorId).first()

  if (existingShare) {
    console.log('Share already exists:', postId, actorId)
    return
  }

  const shareId = generateId()
  await env.DB.prepare(`
    INSERT INTO shares (id, post_id, user_id, actor_id, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(shareId, postId, 'unknown', actorId).run()

  console.log('Share recorded:', postId, actorId)
}

async function handleDeleteActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  const objectUrl = object?.id || object
  if (!objectUrl) {
    console.error('Delete activity missing object')
    return
  }

  console.log('Delete activity received for:', objectUrl)
}

async function handleUndoActivity(activity: any, username: string, actorId: string, env: Env): Promise<void> {
  const object = activity.object
  if (!object) {
    console.error('Undo activity missing object')
    return
  }

  const objectType = object.type
  switch (objectType) {
    case 'Like':
      const objectUrl = object.id || object
      const postIdMatch = objectUrl?.match(/\/notes\/([a-zA-Z0-9]+)/)
      if (postIdMatch) {
        await env.DB.prepare(`
          DELETE FROM likes WHERE post_id = ? AND actor_id = ?
        `).bind(postIdMatch[1], actorId).run()
        console.log('Like removed:', postIdMatch[1], actorId)
      }
      break
    case 'Announce':
      const announceUrl = object.id || object
      const sharePostIdMatch = announceUrl?.match(/\/notes\/([a-zA-Z0-9]+)/)
      if (sharePostIdMatch) {
        await env.DB.prepare(`
          DELETE FROM shares WHERE post_id = ? AND actor_id = ?
        `).bind(sharePostIdMatch[1], actorId).run()
        console.log('Share removed:', sharePostIdMatch[1], actorId)
      }
      break
    case 'Follow':
      const userResult = await env.DB.prepare(`
        SELECT id FROM users WHERE username = ? COLLATE NOCASE
      `).bind(username).first() as { id: string } | null

      if (userResult) {
        await env.DB.prepare(`
          DELETE FROM ap_followers WHERE local_user_id = ? AND actor_url = ?
        `).bind(userResult.id, object.actor).run()
        console.log('Follow removed:', object.actor)
      }
      break
    default:
      console.log('Unknown undo object type:', objectType)
  }
}

function generateId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function generatePostId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let result = ''
  const values = new Uint8Array(10)
  crypto.getRandomValues(values)
  for (let i = 0; i < 10; i++) {
    result += alphabet[values[i] % alphabet.length]
  }
  return result
}
