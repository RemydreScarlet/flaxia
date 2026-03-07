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
  isFreshed: boolean
  onFreshToggle: () => void
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
