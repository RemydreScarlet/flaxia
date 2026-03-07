import { Post } from '../types/post'

export interface PostNode {
  post: Post
  children: PostNode[]
}

export function buildTree(posts: Post[]): PostNode[] {
  const map = new Map<string, PostNode>()
  const roots: PostNode[] = []

  // Create nodes for all posts
  for (const post of posts) {
    map.set(post.id, { post, children: [] })
  }

  // Build the tree structure
  for (const post of posts) {
    const node = map.get(post.id)!
    if (post.parent_id && map.has(post.parent_id)) {
      map.get(post.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

export function findNode(tree: PostNode[], postId: string): PostNode | null {
  for (const node of tree) {
    if (node.post.id === postId) {
      return node
    }
    const found = findNode(node.children, postId)
    if (found) {
      return found
    }
  }
  return null
}

export function countReplies(tree: PostNode[]): number {
  let count = 0
  for (const node of tree) {
    count += 1 + countReplies(node.children)
  }
  return count
}
