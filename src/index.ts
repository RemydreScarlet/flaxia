// Main PostCard component
export { PostCard, createPostCard } from './components/PostCard.js'

// Sub-components (for advanced usage)
export { createPostHeader } from './components/PostHeader.js'
export { createPostText } from './components/PostText.js'
export { createPostStage, updatePostStage } from './components/PostStage.js'
export { createGifPreview } from './components/GifPreview.js'
export { createSandboxFrame } from './components/SandboxFrame.js'
export { createPostActions } from './components/PostActions.js'

// Types
export type { 
  Post, 
  PostCardProps, 
  PostHeaderProps, 
  PostTextProps, 
  PostStageProps, 
  GifPreviewProps, 
  SandboxFrameProps, 
  PostActionsProps 
} from './types/post.js'

export { PostCardMode } from './types/post.js'

// Bridge types for postMessage communication
export type { ParentMessage, SandboxMessage } from './lib/bridge.js'
export { isParentMessage, isSandboxMessage } from './lib/bridge.js'
