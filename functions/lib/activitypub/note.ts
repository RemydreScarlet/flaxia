/// <reference types="@cloudflare/workers-types" />

interface Post {
  id: string
  text: string
  created_at: string
  visibility: string
}

interface User {
  id: string
  username: string
  display_name: string
}

/**
 * Build an ActivityPub Note object from a post
 */
export function buildNoteObject(post: Post, user: User, baseUrl: string): object {
  const noteId = `${baseUrl}/notes/${post.id}`
  const actorUrl = `${baseUrl}/actors/${user.username}`

  const note: any = {
    id: noteId,
    type: 'Note',
    attributedTo: actorUrl,
    content: post.text,
    published: post.created_at,
    url: noteId
  }

  // Set visibility (to/cc)
  if (post.visibility === 'public') {
    note.to = ['https://www.w3.org/ns/activitystreams#Public']
    note.cc = [`${baseUrl}/actors/${user.username}/followers`]
  } else if (post.visibility === 'followers') {
    note.to = [`${baseUrl}/actors/${user.username}/followers`]
    note.cc = []
  } else {
    // Unlisted or private - only to the actor
    note.to = [actorUrl]
    note.cc = []
  }

  return note
}

/**
 * Build a Create activity for a Note
 */
export function buildCreateActivity(note: object, user: User, baseUrl: string): object {
  const noteId = (note as any).id
  const actorUrl = `${baseUrl}/actors/${user.username}`

  // Extract post ID from note URL to create activity ID
  const postId = noteId.split('/notes/')[1]
  const activityId = `${baseUrl}/activities/create-${postId}`

  const to = (note as any).to || []
  const cc = (note as any).cc || []

  return {
    id: activityId,
    type: 'Create',
    actor: actorUrl,
    object: note,
    to: to,
    cc: cc,
    published: new Date().toISOString()
  }
}
