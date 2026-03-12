import { Post, TimelineProps, TimelineState, Ad, TimelineItem, isAd } from '../types/post.js'
import { createPostCard } from './PostCard.js'
import { createPostComposer, PostComposer } from './PostComposer.js'
import { showSignInPrompt, SignInPromptAction } from './SignInPrompt.js'
import { createAdCard } from './AdCard.js'
import { injectAds } from '../lib/inject-ads.js'

export class Timeline {
  private element: HTMLElement
  private props: TimelineProps
  private state: TimelineState
  private postCards: Map<string, ReturnType<typeof createPostCard>> = new Map()
  private composer!: PostComposer
  private intersectionObserver: IntersectionObserver | null = null
  private loadMoreSentinel: HTMLElement | null = null

  constructor(props: TimelineProps) {
    this.props = props
    this.state = {
      mode: 'foryou',
      hashtag: '',
      posts: [],
      ads: [],
      everyN: 8,
      cursor: undefined,
      loading: false,
      hasMore: true
    }
    this.element = this.createElement()
    this.setupEventListeners()
    Promise.all([this.loadInitialPosts(), this.loadAdConfig()])
  }

  private createElement(): HTMLElement {
    const container = document.createElement('section')
    container.className = 'timeline'

    // Sticky tabs at top
    const feedToggle = this.createFeedToggle()
    container.appendChild(feedToggle)

    // Post composer pinned directly below tabs (only for logged-in users)
    if (this.props.currentUser) {
      this.composer = createPostComposer({
        onPostCreated: (post) => this.handleNewPost(post),
        currentUser: this.props.currentUser
      })
      container.appendChild(this.composer.getElement())
    }

    // Hashtag input (hidden by default)
    const hashtagInput = this.createHashtagInput()
    container.appendChild(hashtagInput)

    // Post list
    const postList = this.createPostList()
    container.appendChild(postList)

    // Load more button
    const loadMore = this.createLoadMore()
    container.appendChild(loadMore)

    return container
  }

  private createFeedToggle(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'feed-toggle'

    // Only show Following tab for logged-in users
    if (this.props.currentUser) {
      const followingBtn = document.createElement('button')
      followingBtn.className = 'feed-toggle-btn'
      followingBtn.textContent = 'Following'
      followingBtn.dataset.mode = 'following'
      if (this.state.mode === 'following') {
        followingBtn.classList.add('active')
      }
      container.appendChild(followingBtn)
    }

    const forYouBtn = document.createElement('button')
    forYouBtn.className = 'feed-toggle-btn'
    forYouBtn.textContent = 'Global'
    forYouBtn.dataset.mode = 'foryou'
    if (this.state.mode === 'foryou') {
      forYouBtn.classList.add('active')
    }

    const reloadBtn = document.createElement('button')
    reloadBtn.className = 'feed-toggle-btn feed-reload-btn'
    reloadBtn.innerHTML = '↑ Reload'
    reloadBtn.title = 'Reload posts'

    container.appendChild(forYouBtn)
    container.appendChild(reloadBtn)

    return container
  }

  private createHashtagInput(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'hashtag-input'
    container.style.display = 'none' // Always hidden since we removed hashtag mode

    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Enter hashtag...'
    input.className = 'hashtag-input-field'
    input.value = this.state.hashtag

    const searchBtn = document.createElement('button')
    searchBtn.className = 'hashtag-search-btn'
    searchBtn.textContent = 'Search'

    container.appendChild(input)
    container.appendChild(searchBtn)

    return container
  }

  private createPostList(): HTMLElement {
    const list = document.createElement('div')
    list.className = 'post-list'
    
    if (this.state.posts.length === 0 && !this.state.loading) {
      const emptyState = document.createElement('p')
      emptyState.className = 'font-mono'
      emptyState.textContent = 'No posts yet. XD'
      list.appendChild(emptyState)
    }

    return list
  }

  private createLoadMore(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'load-more-container'

    // Create sentinel element for intersection observer
    this.loadMoreSentinel = document.createElement('div')
    this.loadMoreSentinel.className = 'load-more-sentinel'
    this.loadMoreSentinel.style.height = '100px'
    this.loadMoreSentinel.style.width = '100%'
    
    // Add loading spinner (hidden by default)
    const loadingSpinner = document.createElement('div')
    loadingSpinner.className = 'loading-spinner'
    loadingSpinner.innerHTML = `
      <div class="spinner"></div>
      <span>Loading...</span>
    `
    loadingSpinner.style.display = 'none'
    loadingSpinner.style.textAlign = 'center'
    loadingSpinner.style.padding = '1rem'

    container.appendChild(this.loadMoreSentinel)
    container.appendChild(loadingSpinner)
    
    return container
  }

  private setupEventListeners(): void {
    // Feed toggle
    this.element.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.classList.contains('feed-toggle-btn')) {
        if (target.classList.contains('feed-reload-btn')) {
          this.reloadPosts()
        } else {
          const mode = (target as HTMLElement).dataset.mode as 'following' | 'foryou'
          this.switchMode(mode)
        }
      }
    })

    // Reply toggle events - listen for replyToggle events from post cards
    this.element.addEventListener('replyToggle', (e: any) => {
      const postId = e.detail.postId
      this.handleReplyToggle(postId)
    })
    
    // Thread navigation events - listen for navigateToThread events from post cards
    this.element.addEventListener('navigateToThread', (e: any) => {
      const postId = e.detail.postId
      console.log('Timeline received navigateToThread event for postId:', postId)
      // Let the main app handle this navigation
      console.log('Navigate to thread:', postId)
    })

    // Hashtag search
    const hashtagInput = this.element.querySelector('.hashtag-search-btn') as HTMLButtonElement
    const inputField = this.element.querySelector('.hashtag-input-field') as HTMLInputElement
    
    hashtagInput?.addEventListener('click', () => {
      const hashtag = inputField.value.trim()
      if (hashtag && hashtag !== this.state.hashtag) {
        this.state.hashtag = hashtag
        this.resetAndLoadPosts()
      }
    })

    inputField?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const hashtag = inputField.value.trim()
        if (hashtag && hashtag !== this.state.hashtag) {
          this.state.hashtag = hashtag
          this.resetAndLoadPosts()
        }
      }
    })

    // Setup intersection observer for infinite scroll
    this.setupIntersectionObserver()
  }

  private handleNewPost(post: any): void {
    // Add the new post to the beginning of the timeline
    this.state.posts = [post, ...this.state.posts]
    this.renderPostList()
  }

  private handleReplyToggle(postId: string): void {
    // Find the post card and let it handle the inline reply composer
    const postCard = this.postCards.get(postId)
    if (postCard) {
      // PostCard will handle showing/hiding its inline reply composer
      postCard.handleReplyTogglePublic()
    }
  }

  private switchMode(mode: 'following' | 'foryou'): void {
    if (mode === this.state.mode) return

    this.state.mode = mode
    
    // Update toggle buttons
    const toggleBtns = this.element.querySelectorAll('.feed-toggle-btn')
    toggleBtns.forEach(btn => {
      btn.classList.remove('active')
      if ((btn as HTMLElement).dataset.mode === mode) {
        btn.classList.add('active')
      }
    })

    // Reset and load posts (hashtag input is always hidden now)
    this.resetAndLoadPosts()
  }

  private reloadPosts(): void {
    this.resetAndLoadPosts()
  }

  private setupIntersectionObserver(): void {
    if (!this.loadMoreSentinel) return

    // Disconnect existing observer if any
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect()
    }

    // Create new intersection observer
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && !this.state.loading && this.state.hasMore) {
          this.loadMorePosts()
        }
      },
      {
        root: null, // Use viewport as root
        rootMargin: '100px', // Start loading 100px before sentinel comes into view
        threshold: 0.1 // Trigger when 10% of sentinel is visible
      }
    )

    // Start observing the sentinel
    this.intersectionObserver.observe(this.loadMoreSentinel)
  }

  private resetAndLoadPosts(): void {
    this.state.posts = []
    this.state.cursor = undefined
    this.state.hasMore = true
    this.postCards.clear()
    this.renderPostList()
    
    // Re-setup intersection observer for new content
    this.setupIntersectionObserver()
    
    this.loadInitialPosts()
  }

  private async loadInitialPosts(): Promise<void> {
    if (this.state.loading) return
    
    this.state.loading = true
    this.updateLoadMoreButton()

    try {
      const url = this.buildApiUrl()
      const response = await fetch(url, {
        credentials: 'include'
      })

      if (!response.ok) {
        throw new Error('Failed to fetch posts')
      }

      const data = await response.json() as { posts: Post[] }
      this.state.posts = data.posts
      
      if (data.posts.length > 0) {
        this.state.cursor = data.posts[data.posts.length - 1].created_at
      }
      
      this.state.hasMore = data.posts.length === 20
      this.renderPostList()

    } catch (error) {
      console.error('Failed to load posts:', error)
    } finally {
      this.state.loading = false
      this.updateLoadMoreButton()
    }
  }

  private async loadAdConfig(): Promise<void> {
    const [adsRes, configRes] = await Promise.all([
      fetch('/api/ads/active'),
      fetch('/api/admin/ads/config')  // returns { every_n: number }
    ])
    if (adsRes.ok) {
      const adsData = await adsRes.json() as { ads: Ad[] }
      this.state.ads = adsData.ads
    }
    if (configRes.ok) {
      const configData = await configRes.json() as { every_n: number }
      this.state.everyN = configData.every_n
    }
  }

  private async loadMorePosts(): Promise<void> {
    if (this.state.loading || !this.state.hasMore || !this.state.cursor) return

    this.state.loading = true
    this.updateLoadingSpinner()

    try {
      const url = this.buildApiUrl(this.state.cursor)
      const response = await fetch(url, {
        credentials: 'include'
      })

      if (!response.ok) {
        throw new Error('Failed to fetch more posts')
      }

      const data = await response.json() as { posts: Post[] }
      this.state.posts = [...this.state.posts, ...data.posts]
      
      if (data.posts.length > 0) {
        this.state.cursor = data.posts[data.posts.length - 1].created_at
      }
      
      this.state.hasMore = data.posts.length === 20
      this.renderPostList()

    } catch (error) {
      console.error('Failed to load more posts:', error)
    } finally {
      this.state.loading = false
      this.updateLoadingSpinner()
    }
  }

  private buildApiUrl(cursor?: string): string {
    const params = new URLSearchParams()
    params.set('limit', '20')
    
    if (cursor) {
      params.set('cursor', cursor)
    }

    if (this.state.mode === 'following') {
      // Following tab - filter to show only posts from followed users
      params.set('following', 'true')
      return `/api/posts?${params.toString()}`
    } else {
      // Global mode - same API endpoint, no following filter
      return `/api/posts?${params.toString()}`
    }
  }

  private renderPostList(): void {
    const postList = this.element.querySelector('.post-list') as HTMLElement
    if (!postList) return

    postList.innerHTML = ''

    if (this.state.posts.length === 0) {
      const emptyState = document.createElement('p')
      emptyState.className = 'font-mono'
      emptyState.textContent = 'No posts yet. XD'
      postList.appendChild(emptyState)
      return
    }

    // Inject ads into the timeline
    const timelineItems = injectAds(this.state.posts, this.state.ads, this.state.everyN)

    timelineItems.forEach((item) => {
      if (isAd(item)) {
        // Render ad card
        const adCard = createAdCard(item)
        postList.appendChild(adCard)
      } else {
        // Render post card
        const postCard = createPostCard({
          post: item,
          sandboxOrigin: this.props.sandboxOrigin,
          currentUser: this.props.currentUser,
          onDelete: (postId) => {
            // Remove post from state
            this.state.posts = this.state.posts.filter(p => p.id !== postId)
            this.postCards.delete(postId)
          }
        })
        
        this.postCards.set(item.id, postCard)
        postList.appendChild(postCard.getElement())
      }
    })
  }

  private updateLoadMoreButton(): void {
    this.updateLoadingSpinner()
  }

  private updateLoadingSpinner(): void {
    const loadingSpinner = this.element.querySelector('.loading-spinner') as HTMLElement
    if (!loadingSpinner) return

    if (this.state.loading) {
      loadingSpinner.style.display = 'block'
    } else {
      loadingSpinner.style.display = 'none'
    }

    // Hide sentinel when no more posts
    if (this.loadMoreSentinel) {
      this.loadMoreSentinel.style.display = this.state.hasMore ? 'block' : 'none'
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    // Clean up intersection observer
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect()
      this.intersectionObserver = null
    }
    
    if (this.composer) {
      this.composer.destroy()
    }
    this.postCards.forEach(card => card.destroy())
    this.postCards.clear()
    this.element.remove()
  }
}

// Factory function for easier usage
export function createTimeline(props: TimelineProps): Timeline {
  return new Timeline(props)
}
