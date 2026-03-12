export type ReportCategory =
  | 'spam'
  | 'harassment'
  | 'inappropriate'
  | 'misinformation'
  | 'other'
  | 'hate_speech'
  | 'copyright'
  | 'csam'
  | 'malware'
  | 'privacy'

export type NotificationType = 'fresh' | 'reported' | 'warned' | 'hidden'

export interface Post {
  id: string
  user_id: string
  username: string
  display_name?: string
  avatar_key?: string
  text: string
  hashtags: string
  gif_key?: string  // Stores all image formats (GIF, PNG, JPG), not just GIFs
  payload_key?: string  // Stores ZIP files for HTML execution
  swf_key?: string  // Stores SWF files for Flash execution
  fresh_count: number
  reply_count: number
  parent_id?: string
  root_id?: string
  depth: number
  status: string
  hidden: number
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
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
  onDelete?: (postId: string) => void
}

export interface PostHeaderProps {
  username: string
  display_name?: string
  avatar_key?: string
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
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
}

export interface TimelineState {
  mode: 'following' | 'foryou'
  hashtag: string
  posts: Post[]
  ads: Ad[]
  everyN: number
  cursor?: string
  loading: boolean
  hasMore: boolean
}

export interface Ad {
  id: string
  body_text: string
  payload_key: string | null
  payload_type: 'zip' | 'swf' | 'gif' | 'image' | null
  click_url: string | null
  impressions: number
  clicks: number
}

export type TimelineItem = Post | Ad

export function isAd(item: TimelineItem): item is Ad {
  return 'payload_type' in item
}
