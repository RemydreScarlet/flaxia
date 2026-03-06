// Main PostCard component
export { PostCard, createPostCard } from './components/PostCard.js'

// Timeline component
export { Timeline, createTimeline } from './components/Timeline.js'

// Sandbox bridge
export { SandboxBridge, useSandboxBridge } from './lib/sandbox-bridge.js'
export type { SandboxBridgeOptions } from './lib/sandbox-bridge.js'

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
  TimelineProps,
  TimelineState,
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
