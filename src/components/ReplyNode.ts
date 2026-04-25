import { Post, PostCardProps } from '../types/post.js'
import { PostNode } from '../lib/thread.js'
import { createPostCard, PostCard as PostCardClass } from './PostCard.js'
import { createReplyComposer, ReplyComposer } from './ReplyComposer.js'

export interface ReplyNodeProps {
  node: PostNode
  sandboxOrigin: string
  onReplyCreated: (newReply: Post) => void
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
}

export class ReplyNode {
  private element: HTMLElement
  private props: ReplyNodeProps
  private postCard?: PostCardClass
  private replyComposer?: ReplyComposer
  private childReplyNodes: ReplyNode[] = []
  private isReplyComposerOpen: boolean = false
  private globalReplyListener?: (e: Event) => void

  constructor(props: ReplyNodeProps) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'reply-node'
    container.style.cssText = `
      margin-bottom: 0.75rem;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      border-left: 1px solid #e2e8f0;
      padding-left: calc(${this.props.node.post.depth} * 1.25rem);
    `

    // Post card for this reply
    this.postCard = createPostCard({
      post: this.props.node.post,
      sandboxOrigin: this.props.sandboxOrigin,
      currentUser: this.props.currentUser || undefined,
      onDelete: () => {}, // Add empty onDelete handler to prevent errors
      disableReplyComposer: true // Disable only PostCard's reply composer, ReplyNode handles replies
    })
    container.appendChild(this.postCard.getElement())

    // Reply composer (hidden by default)
    this.replyComposer = createReplyComposer({
      postId: this.props.node.post.id,
      sandboxOrigin: this.props.sandboxOrigin,
      onReplyCreated: (newReply) => this.handleReplyCreated(newReply),
      onCancel: () => this.hideReplyComposer()
    })
    this.replyComposer.getElement().style.display = 'none'
    container.appendChild(this.replyComposer.getElement())

    // Children replies
    if (this.props.node.children.length > 0) {
      const childrenContainer = document.createElement('div')
      childrenContainer.className = 'reply-children'
      childrenContainer.style.cssText = `
        margin-top: 0.75rem;
        padding-left: 1.25rem;
        border-left: 1px solid #e2e8f0;
      `

      this.props.node.children.forEach(childNode => {
        const childReplyNode = new ReplyNode({
          node: childNode,
          sandboxOrigin: this.props.sandboxOrigin,
          currentUser: this.props.currentUser,
          onReplyCreated: (newReply) => this.props.onReplyCreated(newReply)
        })
        this.childReplyNodes.push(childReplyNode)
        childrenContainer.appendChild(childReplyNode.getElement())
      })

      container.appendChild(childrenContainer)
    }

    return container
  }

  private setupEventListeners(): void {
    if (this.postCard) {
      // Listen for reply toggle events on the post card
      this.postCard.getElement().addEventListener('replyToggle', (e: any) => {
        if (e.detail.postId === this.props.node.post.id) {
          this.toggleReplyComposer()
        }
      })
    }

    // Listen for global reply composer open events to close other composers
    this.globalReplyListener = (e: any) => {
      if (e.detail.postId !== this.props.node.post.id && this.isReplyComposerOpen) {
        this.hideReplyComposer()
      }
    }
    document.addEventListener('replyComposerOpen', this.globalReplyListener)
  }

  private toggleReplyComposer(): void {
    if (this.isReplyComposerOpen) {
      this.hideReplyComposer()
    } else {
      this.showReplyComposer()
    }
  }

  private showReplyComposer(): void {
    if (this.replyComposer && this.props.node.post.depth < 5) {
      // Dispatch global event to close other reply composers
      document.dispatchEvent(new CustomEvent('replyComposerOpen', {
        detail: { postId: this.props.node.post.id }
      }))
      
      this.replyComposer.getElement().style.display = 'block'
      this.isReplyComposerOpen = true
    }
  }

  private hideReplyComposer(): void {
    if (this.replyComposer) {
      this.replyComposer.getElement().style.display = 'none'
      this.isReplyComposerOpen = false
    }
  }

  private handleReplyCreated(newReply: Post): void {
    // Hide reply composer after successful reply
    this.hideReplyComposer()
    
    // Notify parent
    this.props.onReplyCreated(newReply)

    // Update this post's reply count
    if (this.postCard) {
      this.postCard.updatePost({
        reply_count: (this.props.node.post.reply_count || 0) + 1
      })
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    // Cleanup global event listener
    if (this.globalReplyListener) {
      document.removeEventListener('replyComposerOpen', this.globalReplyListener)
      this.globalReplyListener = undefined
    }

    // Cleanup child reply nodes
    this.childReplyNodes.forEach(node => node.destroy())
    this.childReplyNodes = []

    // Cleanup post card
    if (this.postCard) {
      this.postCard.destroy()
      this.postCard = undefined
    }

    // Cleanup reply composer
    if (this.replyComposer) {
      this.replyComposer.destroy()
      this.replyComposer = undefined
    }

    this.element.remove()
  }
}

// Factory function for easier usage
export function createReplyNode(props: ReplyNodeProps): ReplyNode {
  return new ReplyNode(props)
}
