import { Post } from '../types/post.js'
import { buildTree, PostNode } from '../lib/thread.js'
import { createPostCard } from './PostCard.js'
import { createReplyNode, ReplyNode } from './ReplyNode.js'
import { createLeftNav } from './LeftNav.js'
import { createRightPanel } from './RightPanel.js'

export interface ThreadPageProps {
  postId: string
  sandboxOrigin: string
  onBack: () => void
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
}

export class ThreadPage {
  private element: HTMLElement
  private props: ThreadPageProps
  private rootPostCard?: ReturnType<typeof createPostCard>
  private replyNodes: ReplyNode[] = []
  private isLoading: boolean = false
  private leftNav?: ReturnType<typeof createLeftNav>
  private rightPanel?: ReturnType<typeof createRightPanel>

  constructor(props: ThreadPageProps) {
    this.props = props
    this.element = this.createElement()
    this.loadThread()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'thread-page'
    container.style.cssText = `
      background: #ffffff;
      min-height: 100vh;
      font-family: system-ui, -apple-system, sans-serif;
    `

    // Create main container with 3-column layout
    const mainContainer = document.createElement('div')
    mainContainer.className = 'main-container'
    mainContainer.style.cssText = `
      display: flex;
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
    `

    // Create Left Nav
    this.leftNav = createLeftNav({
      activeItem: 'home',
      currentUser: this.props.currentUser || undefined,
      onNavigate: async (item) => {
        console.log('Navigate to:', item)
        // Handle navigation - this will need to be passed from parent
        if (item === 'home') {
          window.history.pushState({}, '', '/')
          this.props.onBack()
        } else if (item === 'explore') {
          window.history.pushState({}, '', '/explore')
          window.location.reload() // Simple navigation for now
        } else if (item === 'notifications') {
          if (this.props.currentUser) {
            window.history.pushState({}, '', '/notifications')
            window.location.reload()
          }
        } else if (item === 'profile') {
          if (this.props.currentUser) {
            window.history.pushState({}, '', `/users/${this.props.currentUser.username}`)
            window.location.reload()
          }
        } else if (item === 'post') {
          // For guests, clicking Post should show sign-in prompt
          if (!this.props.currentUser) {
            const { showSignInPrompt } = await import('./SignInPrompt.js')
            showSignInPrompt(
              'post',
              () => window.location.href = '/login',
              () => window.location.href = '/register'
            )
          }
        }
      },
      onSignIn: () => {
        window.location.href = '/login'
      },
      onSignUp: () => {
        window.location.href = '/register'
      }
    })
    this.leftNav.getElement().style.cssText = `
      width: 240px;
      flex-shrink: 0;
      padding: 1rem;
      border-right: 1px solid #e2e8f0;
    `

    // Create main content area (centered)
    const mainContent = document.createElement('div')
    mainContent.className = 'thread-main-content'
    mainContent.style.cssText = `
      flex: 1;
      max-width: 600px;
      padding: 1rem;
      border-right: 1px solid #e2e8f0;
    `

    // Thread content (will be populated by loadThread)
    const threadContent = document.createElement('div')
    threadContent.className = 'thread-content'
    threadContent.id = `thread-content-${this.props.postId}`

    // Loading state
    const loading = document.createElement('div')
    loading.className = 'thread-loading'
    loading.textContent = 'Loading thread...'
    loading.style.cssText = `
      color: #64748b;
      font-family: system-ui, -apple-system, sans-serif;
      text-align: center;
      padding: 4rem 2rem;
      font-size: 1.125rem;
    `

    // Create Right Panel
    this.rightPanel = createRightPanel({
      onSearch: (query) => {
        console.log('Search:', query)
      },
      onFollowUser: (userId) => {
        console.log('Follow user:', userId)
      }
    })
    this.rightPanel.getElement().style.cssText = `
      width: 350px;
      flex-shrink: 0;
      padding: 1rem;
    `

    // Add thread header to main content
    const header = document.createElement('div')
    header.className = 'thread-header'
    header.style.cssText = `
      display: flex;
      align-items: center;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #e2e8f0;
    `

    const backButton = document.createElement('button')
    backButton.textContent = '← Back'
    backButton.style.cssText = `
      background: none;
      border: none;
      color: #22c55e;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 1rem;
      cursor: pointer;
      padding: 0.5rem;
      margin-right: 1rem;
    `
    backButton.addEventListener('click', this.props.onBack)

    const title = document.createElement('h1')
    title.textContent = 'Thread'
    title.style.cssText = `
      color: #0f172a;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 1.25rem;
      margin: 0;
      font-weight: normal;
    `

    header.appendChild(backButton)
    header.appendChild(title)

    // Assemble main content
    mainContent.appendChild(header)
    mainContent.appendChild(threadContent)
    mainContent.appendChild(loading)

    // Assemble layout
    mainContainer.appendChild(this.leftNav.getElement())
    mainContainer.appendChild(mainContent)
    mainContainer.appendChild(this.rightPanel.getElement())
    container.appendChild(mainContainer)

    // Add responsive styles
    this.addResponsiveStyles(container)

    return container
  }

  private addResponsiveStyles(container: HTMLElement): void {
    const style = document.createElement('style')
    style.textContent = `
      @media (max-width: 1024px) {
        .thread-page .main-container {
          max-width: 840px;
        }
        .thread-page .thread-main-content {
          border-right: none;
        }
        .thread-page .right-panel {
          display: none;
        }
      }
      
      @media (max-width: 768px) {
        .thread-page .main-container {
          flex-direction: column;
          max-width: 100%;
        }
        .thread-page .left-nav {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          width: 100%;
          height: 60px;
          border-right: none;
          border-top: 1px solid #e2e8f0;
          padding: 0;
          z-index: 1000;
          display: flex;
          justify-content: space-around;
          align-items: center;
        }
        .thread-page .thread-main-content {
          padding-bottom: 80px;
          border-right: none;
          max-width: 100%;
        }
        .thread-page .nav-logo,
        .thread-page .nav-post-button {
          display: none;
        }
        .thread-page .nav-items {
          display: flex;
          flex-direction: row;
          gap: 0;
          margin: 0;
          width: 100%;
        }
        .thread-page .nav-item {
          flex: 1;
          justify-content: center;
          padding: 0.5rem;
          font-size: 0.875rem;
          border-radius: 0;
        }
        .thread-page .nav-item span:first-child {
          margin-right: 0;
        }
        .thread-page .nav-item span:last-child {
          display: none;
        }
      }
    `
    container.appendChild(style)
  }

  private async loadThread(): Promise<void> {
    this.isLoading = true
    const content = this.element.querySelector('.thread-content') as HTMLElement
    const loading = this.element.querySelector('.thread-loading') as HTMLElement

    try {
      const response = await fetch(`/api/posts/${this.props.postId}/thread`)
      if (!response.ok) {
        throw new Error('Failed to load thread')
      }

      const data = await response.json() as { root: Post; replies: Post[] }
      
      // Clear loading state
      loading.style.display = 'none'

      // Create root post card (without reply functionality since we're on thread page)
      this.rootPostCard = createPostCard({
        post: data.root,
        sandboxOrigin: this.props.sandboxOrigin,
        currentUser: this.props.currentUser || undefined
      })
      content.appendChild(this.rootPostCard.getElement())

      // Add separator
      const separator = document.createElement('div')
      separator.style.cssText = `
        border-top: 1px solid #e2e8f0;
        margin: 1.5rem 0;
      `
      content.appendChild(separator)

      // Add replies header
      const repliesHeader = document.createElement('h2')
      repliesHeader.textContent = `Replies (${data.replies.length})`
      repliesHeader.style.cssText = `
        color: #64748b;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 1rem;
        margin: 0 0 1rem 0;
        font-weight: normal;
      `
      content.appendChild(repliesHeader)

      // Build reply tree and render
      if (data.replies.length > 0) {
        const replyTree = buildTree(data.replies)
        const repliesContainer = document.createElement('div')
        repliesContainer.className = 'replies-container'

        replyTree.forEach(node => {
          const replyNode = createReplyNode({
            node,
            sandboxOrigin: this.props.sandboxOrigin,
            currentUser: this.props.currentUser,
            onReplyCreated: (newReply) => this.handleReplyCreated(newReply)
          })
          this.replyNodes.push(replyNode)
          repliesContainer.appendChild(replyNode.getElement())
        })

        content.appendChild(repliesContainer)
      } else {
        const noReplies = document.createElement('p')
        noReplies.textContent = 'No replies yet. Be the first to reply!'
        noReplies.style.cssText = `
          color: #64748b;
          font-family: system-ui, -apple-system, sans-serif;
          text-align: center;
          padding: 2rem;
          font-style: italic;
        `
        content.appendChild(noReplies)
      }

    } catch (error) {
      console.error('Failed to load thread:', error)
      loading.textContent = 'Failed to load thread'
      loading.style.color = '#ef4444'
    } finally {
      this.isLoading = false
    }
  }

  private handleReplyCreated(newReply: Post): void {
    // Increment reply count on root post
    if (this.rootPostCard) {
      this.rootPostCard.updatePost({
        reply_count: (this.rootPostCard['props'].post.reply_count || 0) + 1
      })
    }

    // Reload the thread to show the new reply
    this.loadThread()
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    // Cleanup reply nodes
    this.replyNodes.forEach(node => node.destroy())
    this.replyNodes = []

    // Cleanup root post card
    if (this.rootPostCard) {
      this.rootPostCard.destroy()
      this.rootPostCard = undefined
    }

    // Cleanup left nav
    if (this.leftNav) {
      this.leftNav.destroy()
      this.leftNav = undefined
    }

    // Cleanup right panel
    if (this.rightPanel) {
      this.rightPanel.destroy()
      this.rightPanel = undefined
    }

    this.element.remove()
  }
}

// Factory function for easier usage
export function createThreadPage(props: ThreadPageProps): ThreadPage {
  return new ThreadPage(props)
}
