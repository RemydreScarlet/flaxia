export interface Post {
  id: string
  user_id: string
  username: string
  text: string
  hashtags: string
  gif_key?: string
  payload_key?: string
  fresh_count: number
  created_at: string
}

export interface Follow {
  follower_id: string
  followee_id: string
}

export interface Fresh {
  post_id: string
  user_id: string
}

export class Database {
  constructor(private db: D1Database) {}
  
  async getPosts(cursor?: string, limit = 20): Promise<Post[]> {
    let query = 'SELECT * FROM posts ORDER BY created_at DESC LIMIT ?'
    const params = [limit]
    
    if (cursor) {
      query = 'SELECT * FROM posts WHERE created_at < ? ORDER BY created_at DESC LIMIT ?'
      params.unshift(cursor)
    }
    
    const result = await this.db.prepare(query).bind(...params).all()
    return result.results as Post[]
  }
  
  async createPost(post: Omit<Post, 'created_at' | 'fresh_count'>): Promise<string> {
    const id = crypto.randomUUID()
    await this.db.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, gif_key, payload_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      post.user_id,
      post.username,
      post.text,
      post.hashtags,
      post.gif_key || null,
      post.payload_key || null
    ).run()
    
    return id
  }
  
  async toggleFresh(postId: string, userId: string): Promise<boolean> {
    const existing = await this.db.prepare(
      'SELECT * FROM freshs WHERE post_id = ? AND user_id = ?'
    ).bind(postId, userId).first()
    
    if (existing) {
      await this.db.prepare(
        'DELETE FROM freshs WHERE post_id = ? AND user_id = ?'
      ).bind(postId, userId).run()
      
      await this.db.prepare(
        'UPDATE posts SET fresh_count = fresh_count - 1 WHERE id = ?'
      ).bind(postId).run()
      
      return false
    } else {
      await this.db.prepare(
        'INSERT INTO freshs (post_id, user_id) VALUES (?, ?)'
      ).bind(postId, userId).run()
      
      await this.db.prepare(
        'UPDATE posts SET fresh_count = fresh_count + 1 WHERE id = ?'
      ).bind(postId).run()
      
      return true
    }
  }
}
