import { Post, TimelineProps, TimelineState } from '../types/post.js'
import { createPostCard } from './PostCard.js'
import { createPostComposer, PostComposer } from './PostComposer.js'

export class Timeline {
  private element: HTMLElement
  private props: TimelineProps
  private state: TimelineState
  private postCards: Map<string, ReturnType<typeof createPostCard>> = new Map()
  private composer!: PostComposer

  constructor(props: TimelineProps) {
    this.props = props
    this.state = {
      mode: 'following',
      hashtag: '',
      posts: [],
      loading: false,
      hasMore: true
    }
    this.element = this.createElement()
    this.setupEventListeners()
    this.loadInitialPosts()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('section')
    container.className = 'timeline'

    // Post composer
    this.composer = createPostComposer({
      onPostCreated: (post) => this.handleNewPost(post)
    })
    container.appendChild(this.composer.getElement())

    // Feed toggle
    const feedToggle = this.createFeedToggle()
    container.appendChild(feedToggle)

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

    const followingBtn = document.createElement('button')
    followingBtn.className = 'feed-toggle-btn'
    followingBtn.textContent = 'Following'
    followingBtn.dataset.mode = 'following'
    if (this.state.mode === 'following') {
      followingBtn.classList.add('active')
    }

    const hashtagBtn = document.createElement('button')
    hashtagBtn.className = 'feed-toggle-btn'
    hashtagBtn.textContent = 'Hashtag'
    hashtagBtn.dataset.mode = 'hashtag'
    if (this.state.mode === 'hashtag') {
      hashtagBtn.classList.add('active')
    }

    container.appendChild(followingBtn)
    container.appendChild(hashtagBtn)

    return container
  }

  private createHashtagInput(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'hashtag-input'
    if (this.state.mode !== 'hashtag') {
      container.style.display = 'none'
    }

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

    const button = document.createElement('button')
    button.className = 'load-more-btn'
    button.textContent = 'Load More'
    button.disabled = this.state.loading || !this.state.hasMore

    if (!this.state.hasMore) {
      button.style.display = 'none'
    }

    container.appendChild(button)
    return container
  }

  private setupEventListeners(): void {
    // Feed toggle
    this.element.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.classList.contains('feed-toggle-btn')) {
        const mode = (target as HTMLElement).dataset.mode as 'following' | 'hashtag'
        this.switchMode(mode)
      }
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

    // Load more
    const loadMoreBtn = this.element.querySelector('.load-more-btn') as HTMLButtonElement
    loadMoreBtn?.addEventListener('click', () => {
      this.loadMorePosts()
    })
  }

  private handleNewPost(post: any): void {
    // Add the new post to the beginning of the timeline
    this.state.posts = [post, ...this.state.posts]
    this.renderPostList()
  }

  private switchMode(mode: 'following' | 'hashtag'): void {
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

    // Show/hide hashtag input
    const hashtagInput = this.element.querySelector('.hashtag-input') as HTMLElement
    if (hashtagInput) {
      hashtagInput.style.display = mode === 'hashtag' ? 'flex' : 'none'
    }

    // Reset and load posts
    this.resetAndLoadPosts()
  }

  private resetAndLoadPosts(): void {
    this.state.posts = []
    this.state.cursor = undefined
    this.state.hasMore = true
    this.postCards.clear()
    this.renderPostList()
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

  private async loadMorePosts(): Promise<void> {
    if (this.state.loading || !this.state.hasMore || !this.state.cursor) return

    this.state.loading = true
    this.updateLoadMoreButton()

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
      this.updateLoadMoreButton()
    }
  }

  private buildApiUrl(cursor?: string): string {
    const params = new URLSearchParams()
    params.set('limit', '20')
    
    if (cursor) {
      params.set('cursor', cursor)
    }

    if (this.state.mode === 'following') {
      return `/api/posts?${params.toString()}`
    } else {
      if (this.state.hashtag) {
        params.set('hashtag', this.state.hashtag)
      }
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

    this.state.posts.forEach((post, index) => {
      // Inject AdBanner every 8th slot (index 7, 15, 23, etc.)
      if (index > 0 && index % 8 === 0) {
        const adBanner = this.createAdBanner()
        postList.appendChild(adBanner)
      }

      const postCard = createPostCard({
        post,
        sandboxOrigin: this.props.sandboxOrigin
      })
      
      this.postCards.set(post.id, postCard)
      postList.appendChild(postCard.getElement())
    })
  }

  private createAdBanner(): HTMLElement {
    const adBanner = document.createElement('div')
    adBanner.className = 'ad-banner'
    adBanner.innerHTML = `
      <div class="ad-content">
        <span class="ad-label">ADVERTISEMENT</span>
        <div class="ad-placeholder">
          <p>Ad Space</p>
        </div>
      </div>
    `
    return adBanner
  }

  private updateLoadMoreButton(): void {
    const button = this.element.querySelector('.load-more-btn') as HTMLButtonElement
    if (!button) return

    button.disabled = this.state.loading
    button.textContent = this.state.loading ? 'Loading...' : 'Load More'

    if (!this.state.hasMore) {
      button.style.display = 'none'
    } else {
      button.style.display = 'block'
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    this.composer.destroy()
    this.postCards.forEach(card => card.destroy())
    this.postCards.clear()
    this.element.remove()
  }
}

// Factory function for easier usage
export function createTimeline(props: TimelineProps): Timeline {
  return new Timeline(props)
}
