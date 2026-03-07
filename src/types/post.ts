export interface Post {
  id: string
  user_id: string
  username: string
  text: string
  hashtags: string
  gif_key?: string  // Stores all image formats (GIF, PNG, JPG), not just GIFs
  payload_key?: string
  fresh_count: number
  reply_count: number
  parent_id?: string
  root_id?: string
  depth: number
  status: string
  created_at: string
}

export enum PostCardMode {
  PREVIEW = 'preview',
  EXECUTING = 'executing'
}

export interface PostCardProps {
  post: Post
  sandboxOrigin: string
  initialMode?: PostCardMode
}

export interface PostHeaderProps {
  username: string
  createdAt: string
}

export interface PostTextProps {
  text: string
}

export interface PostStageProps {
  post: Post
  mode: PostCardMode
  sandboxOrigin: string
  onModeChange: (mode: PostCardMode) => void
}

export interface GifPreviewProps {
  gifKey?: string
  postId: string
}

export interface SandboxFrameProps {
  postId: string
  sandboxOrigin: string
}

export interface PostActionsProps {
  postId: string
  freshCount: number
  replyCount: number
  isFreshed: boolean
  onFreshToggle: () => void
  onReplyToggle: () => void
}

export interface TimelineProps {
  sandboxOrigin: string
}

export interface TimelineState {
  mode: 'following' | 'foryou'
  hashtag: string
  posts: Post[]
  cursor?: string
  loading: boolean
  hasMore: boolean
}
