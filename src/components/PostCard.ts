import { PostCardProps, PostCardMode } from '../types/post.js'
import { createPostHeader } from './PostHeader.js'
import { createPostText } from './PostText.js'
import { createPostStage, updatePostStage } from './PostStage.js'
import { createPostActions } from './PostActions.js'
import { createReplyComposer, ReplyComposer } from './ReplyComposer.js'
import { useSandboxBridge } from '../lib/sandbox-bridge.js'

export class PostCard {
  private element: HTMLElement
  private props: PostCardProps
  private mode: PostCardMode
  private isFreshed: boolean
  private freshCount: number
  private replyCount: number
  private postStageElement?: HTMLElement
  private sandboxBridge?: ReturnType<typeof useSandboxBridge>
  private replyComposer?: ReplyComposer
  private isReplyComposerOpen: boolean = false

  constructor(props: PostCardProps) {
    this.props = props
    this.mode = props.initialMode || PostCardMode.PREVIEW
    this.isFreshed = false // TODO: Fetch from API
    this.freshCount = props.post.fresh_count
    this.replyCount = props.post.reply_count || 0
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('article')
    container.className = 'post-card'
    container.setAttribute('data-post-id', this.props.post.id)
    container.style.cursor = 'pointer' // Indicate clickable

    // Post header
    const header = createPostHeader({
      username: this.props.post.username,
      createdAt: this.props.post.created_at
    })
    container.appendChild(header)

    // Post text
    const text = createPostText({
      text: this.props.post.text
    })
    container.appendChild(text)

    // Post stage (16:9 container for GIF/iframe) - only show if has attachments
    if (this.props.post.gif_key || this.props.post.payload_key) {
      this.postStageElement = createPostStage({
        post: this.props.post,
        mode: this.mode,
        sandboxOrigin: this.props.sandboxOrigin,
        onModeChange: (newMode) => this.handleModeChange(newMode)
      })
      container.appendChild(this.postStageElement)
    }

    // Post actions
    const actions = createPostActions({
      postId: this.props.post.id,
      freshCount: this.freshCount,
      replyCount: this.replyCount,
      isFreshed: this.isFreshed,
      onFreshToggle: () => this.handleFreshToggle(),
      onReplyToggle: () => this.handleReplyToggle()
    })
    container.appendChild(actions)

    // Reply composer (hidden by default)
    this.replyComposer = createReplyComposer({
      postId: this.props.post.id,
      sandboxOrigin: this.props.sandboxOrigin,
      onReplyCreated: (newReply) => this.handleReplyCreated(newReply),
      onCancel: () => this.hideReplyComposer()
    })
    this.replyComposer.getElement().style.display = 'none'
    container.appendChild(this.replyComposer.getElement())

    return container
  }

  private setupEventListeners(): void {
    // Setup sandbox bridge when iframe is available
    this.setupSandboxBridge()
    
    // Add click handler for post navigation (but not for buttons/inputs)
    this.element.addEventListener('click', (e) => {
      console.log('PostCard clicked, target:', e.target)
      
      // Don't navigate if clicking on buttons, inputs, or links
      const target = e.target as HTMLElement
      const closestButton = target.closest('button')
      const closestInput = target.closest('input')
      const closestTextarea = target.closest('textarea')
      const closestLink = target.closest('a')
      
      console.log('Checking if should prevent navigation:', {
        closestButton,
        closestInput,
        closestTextarea,
        closestLink
      })
      
      if (closestButton || closestInput || closestTextarea || closestLink) {
        console.log('Navigation prevented - clicked on interactive element')
        return
      }
      
      console.log('Navigating to thread for post:', this.props.post.id)
      // Navigate to thread page
      this.handlePostClick()
    })
  }

  private setupSandboxBridge(): void {
    // Find the iframe in the post stage
    const iframe = this.element.querySelector('.sandbox-frame') as HTMLIFrameElement
    
    if (iframe) {
      this.sandboxBridge = useSandboxBridge({
        iframe,
        post: this.props.post,
        onFreshRequest: () => this.handleFreshToggle()
      })
    } else {
      // Iframe might not be ready yet, try again after a delay
      setTimeout(() => this.setupSandboxBridge(), 100)
    }
  }

  private handleModeChange(newMode: PostCardMode): void {
    this.mode = newMode
    if (this.postStageElement) {
      updatePostStage(this.postStageElement, {
        post: this.props.post,
        mode: this.mode,
        sandboxOrigin: this.props.sandboxOrigin,
        onModeChange: (newMode) => this.handleModeChange(newMode)
      })
    }
  }

  private async handleFreshToggle(): Promise<void> {
    const previousFreshed = this.isFreshed
    const previousCount = this.freshCount

    // Optimistic update
    this.isFreshed = !previousFreshed
    this.freshCount = previousFreshed ? previousCount - 1 : previousCount + 1

    // Update UI immediately
    this.updateActions()

    try {
      const response = await fetch(`/api/posts/${this.props.post.id}/fresh`, {
        method: 'POST',
        credentials: 'include'
      })

      if (!response.ok) {
        throw new Error('Failed to toggle fresh')
      }

      const result = await response.json() as { freshed: boolean }
      
      // Sync with server response
      this.isFreshed = result.freshed
      this.freshCount = result.freshed ? previousCount + 1 : previousCount - 1

    } catch (error) {
      // Rollback on error
      this.isFreshed = previousFreshed
      this.freshCount = previousCount
      console.error('Failed to toggle fresh:', error)
    }

    this.updateActions()
  }

  private handleReplyToggle(): void {
    // Emit custom event for thread view toggle (legacy, now handled inline)
    const event = new CustomEvent('replyToggle', {
      detail: { postId: this.props.post.id }
    })
    this.element.dispatchEvent(event)

    // Toggle inline reply composer
    this.toggleReplyComposer()
  }

  private toggleReplyComposer(): void {
    if (this.isReplyComposerOpen) {
      this.hideReplyComposer()
    } else {
      this.showReplyComposer()
    }
  }

  private showReplyComposer(): void {
    if (this.replyComposer) {
      this.replyComposer.getElement().style.display = 'block'
      this.isReplyComposerOpen = true
      this.replyComposer.focus()
    }
  }

  private hideReplyComposer(): void {
    if (this.replyComposer) {
      this.replyComposer.getElement().style.display = 'none'
      this.isReplyComposerOpen = false
    }
  }

  private handleReplyCreated(newReply: any): void {
    // Hide reply composer after successful reply
    this.hideReplyComposer()
    
    // Update reply count
    this.replyCount++
    this.updatePost({ reply_count: this.replyCount })
    this.updateActions()
  }

  public handleReplyTogglePublic(): void {
    this.handleReplyToggle()
  }

  private handlePostClick(): void {
    console.log('handlePostClick called for post:', this.props.post.id)
    
    // Navigate to thread page
    const threadUrl = `/posts/${this.props.post.id}`
    console.log('Pushing state to URL:', threadUrl)
    window.history.pushState({ postId: this.props.post.id }, '', threadUrl)
    
    // Manually trigger routing since pushState doesn't trigger popstate
    console.log('Manually triggering navigation after pushState')
    const event = new PopStateEvent('popstate', { state: { postId: this.props.post.id } })
    window.dispatchEvent(event)
    
    // Also emit custom event for navigation (backup)
    console.log('Emitting navigateToThread event')
    const customEvent = new CustomEvent('navigateToThread', {
      detail: { postId: this.props.post.id }
    })
    this.element.dispatchEvent(customEvent)
    console.log('Event dispatched')
  }

  private updateActions(): void {
    const actionsContainer = this.element.querySelector('.post-actions')
    if (actionsContainer) {
      const newActions = createPostActions({
        postId: this.props.post.id,
        freshCount: this.freshCount,
        replyCount: this.replyCount,
        isFreshed: this.isFreshed,
        onFreshToggle: () => this.handleFreshToggle(),
        onReplyToggle: () => this.handleReplyToggle()
      })
      actionsContainer.replaceWith(newActions)
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public updatePost(post: Partial<typeof this.props.post>): void {
    this.props.post = { ...this.props.post, ...post }
    // Re-render if needed
  }

  public destroy(): void {
    // Cleanup sandbox bridge
    if (this.sandboxBridge) {
      this.sandboxBridge.destroy()
      this.sandboxBridge = undefined
    }

    // Cleanup reply composer
    if (this.replyComposer) {
      this.replyComposer.destroy()
      this.replyComposer = undefined
    }
    
    // Cleanup event listeners
    this.element.remove()
  }
}

// Factory function for easier usage
export function createPostCard(props: PostCardProps): PostCard {
  return new PostCard(props)
}
