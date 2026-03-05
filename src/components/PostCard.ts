import { PostCardProps, PostCardMode } from '../types/post.js'
import { createPostHeader } from './PostHeader.js'
import { createPostText } from './PostText.js'
import { createPostStage, updatePostStage } from './PostStage.js'
import { createPostActions } from './PostActions.js'

export class PostCard {
  private element: HTMLElement
  private props: PostCardProps
  private mode: PostCardMode
  private isFreshed: boolean
  private freshCount: number
  private postStageElement?: HTMLElement

  constructor(props: PostCardProps) {
    this.props = props
    this.mode = props.initialMode || PostCardMode.PREVIEW
    this.isFreshed = false // TODO: Fetch from API
    this.freshCount = props.post.fresh_count
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('article')
    container.className = 'post-card'
    container.setAttribute('data-post-id', this.props.post.id)

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

    // Post stage (16:9 container for GIF/iframe)
    this.postStageElement = createPostStage({
      post: this.props.post,
      mode: this.mode,
      sandboxOrigin: this.props.sandboxOrigin,
      onModeChange: (newMode) => this.handleModeChange(newMode)
    })
    container.appendChild(this.postStageElement)

    // Post actions
    const actions = createPostActions({
      postId: this.props.post.id,
      freshCount: this.freshCount,
      isFreshed: this.isFreshed,
      onFreshToggle: () => this.handleFreshToggle()
    })
    container.appendChild(actions)

    return container
  }

  private setupEventListeners(): void {
    // Listen for sandbox messages
    window.addEventListener('sandboxRequestFresh', (event: any) => {
      if (event.detail.postId === this.props.post.id) {
        this.handleFreshToggle()
      }
    })

    window.addEventListener('sandboxPostScore', (event: any) => {
      if (event.detail.postId === this.props.post.id) {
        console.log('Score submitted:', event.detail.score, event.detail.label)
        // TODO: Handle score submission
      }
    })
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

  private updateActions(): void {
    const actionsContainer = this.element.querySelector('.post-actions')
    if (actionsContainer) {
      const newActions = createPostActions({
        postId: this.props.post.id,
        freshCount: this.freshCount,
        isFreshed: this.isFreshed,
        onFreshToggle: () => this.handleFreshToggle()
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
    // Cleanup event listeners
    this.element.remove()
  }
}

// Factory function for easier usage
export function createPostCard(props: PostCardProps): PostCard {
  return new PostCard(props)
}
