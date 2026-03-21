import { createPostCard } from './PostCard.js'
import { Post } from '../types/post.js'

export interface ExplorePageProps {
  tag?: string
  sandboxOrigin: string
}

export class ExplorePage {
  private element: HTMLElement
  private props: ExplorePageProps
  private posts: Post[] = []
  private cursor?: string
  private loading = false
  private hasMore = true

  constructor(props: ExplorePageProps) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
    this.loadPosts()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'explore-page'

    // Add search section
    const searchSection = this.createSearchSection()
    container.appendChild(searchSection)

    if (this.props.tag) {
      // Tag view
      const tagHeader = document.createElement('div')
      tagHeader.className = 'explore-header'
      tagHeader.innerHTML = `
        <h1 class="explore-title"># ${this.props.tag}</h1>
      `
      container.appendChild(tagHeader)
      container.appendChild(document.createElement('div')).className = 'explore-posts'
    } else {
      // Trending view
      const exploreHeader = document.createElement('div')
      exploreHeader.className = 'explore-header'
      exploreHeader.innerHTML = `
        <h1 class="explore-title">Explore</h1>
      `
      container.appendChild(exploreHeader)
      container.appendChild(document.createElement('div')).className = 'explore-trending'
    }

    container.appendChild(document.createElement('div')).className = 'explore-loading'
    container.querySelector('.explore-loading')!.setAttribute('style', 'display: none;')
    
    return container
  }

  private createSearchSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'explore-search-section'
    section.style.cssText = `
      padding: 1rem;
      border-bottom: 1px solid var(--border);
    `
    
    section.innerHTML = `
      <div class="search-box" style="position: relative; margin-bottom: 1rem;">
        <input 
          type="text" 
          class="search-input" 
          placeholder="Search Flaxia"
          style="width: 100%; padding: 0.75rem 1rem 0.75rem 2.5rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 9999px; color: var(--text-primary); font-family: system-ui, -apple-system, sans-serif; font-size: 0.875rem; outline: none; transition: border-color 0.2s ease;"
        />
        <span class="search-icon" style="position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 0.875rem;">🔍</span>
      </div>
    `

    return section
  }

  private setupEventListeners(): void {
    // Search functionality
    const searchInput = this.element.querySelector('.search-input') as HTMLInputElement
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        // Just update input value, no auto-search
      })

      searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const query = searchInput.value.trim()
          if (query) {
            this.performSearch(query)
          }
        }
      })
    }

    // Infinite scroll
    window.addEventListener('scroll', () => {
      if (this.loading || !this.hasMore) return

      const scrollPosition = window.innerHeight + window.scrollY
      const threshold = document.body.offsetHeight - 500

      if (scrollPosition >= threshold) {
        this.loadMorePosts()
      }
    })
  }

  private async performSearch(query: string): Promise<void> {
    try {
      console.log('Searching for:', query)
      
      // Show loading state
      const searchBox = this.element.querySelector('.search-box')
      if (searchBox) {
        searchBox.classList.add('searching')
      }

      // Search posts
      const postsResponse = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=posts&limit=10`)
      const postsData = postsResponse.ok ? await postsResponse.json() as { results: any[] } : { results: [] }

      // Search users
      const usersResponse = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=users&limit=5`)
      const usersData = usersResponse.ok ? await usersResponse.json() as { results: any[] } : { results: [] }

      // Remove loading state
      if (searchBox) {
        searchBox.classList.remove('searching')
      }

      // Import and show search results
      const { createSearchResults } = await import('./SearchResults.js')
      const searchResults = createSearchResults({
        query,
        posts: postsData.results || [],
        users: usersData.results || [],
        onClose: () => {
          document.body.removeChild(searchResults)
        }
      })

      document.body.appendChild(searchResults)

    } catch (error) {
      console.error('Search error:', error)
      
      // Remove loading state
      const searchBox = this.element.querySelector('.search-box')
      if (searchBox) {
        searchBox.classList.remove('searching')
      }
    }
  }

  private async loadPosts(): Promise<void> {
    if (this.loading) return

    this.loading = true
    this.updateLoadingState(true)

    try {
      if (this.props.tag) {
        // Load posts with this tag
        let url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag)}&limit=10`
        if (this.cursor) {
          url += `&cursor=${encodeURIComponent(this.cursor)}`
        }

        const response = await fetch(url)
        if (!response.ok) {
          throw new Error('Failed to load posts')
        }

        const data = await response.json() as { posts: Post[] }
        this.posts = data.posts || []
        this.hasMore = this.posts.length === 20 && this.posts.length > 0
        this.cursor = this.posts.length > 0 ? this.posts[this.posts.length - 1].created_at : undefined

        this.renderPosts()
      } else {
        // Load trending tags
        await this.loadTrendingTags()
      }
    } catch (error) {
      console.error('Failed to load explore content:', error)
    } finally {
      this.loading = false
      this.updateLoadingState(false)
    }
  }

  private async loadMorePosts(): Promise<void> {
    if (this.loading || !this.hasMore || !this.props.tag) return

    this.loading = true
    this.updateLoadingState(true)

    try {
      let url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag)}&limit=10`
      if (this.cursor) {
        url += `&cursor=${encodeURIComponent(this.cursor)}`
      }

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error('Failed to load more posts')
      }

      const data = await response.json() as { posts: Post[] }
      const newPosts = data.posts || []

      if (newPosts.length > 0) {
        this.posts.push(...newPosts)
        this.cursor = newPosts[newPosts.length - 1].created_at
        this.hasMore = newPosts.length === 20 && newPosts.length > 0
        this.renderPosts()
      } else {
        this.hasMore = false
      }
    } catch (error) {
      console.error('Failed to load more posts:', error)
    } finally {
      this.loading = false
      this.updateLoadingState(false)
    }
  }

  private async loadTrendingTags(): Promise<void> {
    try {
      const response = await fetch('/api/tags/trending')
      if (!response.ok) {
        throw new Error('Failed to load trending tags')
      }

      const data = await response.json() as { tags: Array<{ tag: string; post_count: number }> }
      const tags = data.tags || []

      this.renderTrendingTags(tags)
    } catch (error) {
      console.error('Failed to load trending tags:', error)
    }
  }

  private renderPosts(): void {
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement
    if (!postsContainer) return

    postsContainer.innerHTML = ''

    this.posts.forEach(post => {
      const postCard = createPostCard({
        post,
        sandboxOrigin: this.props.sandboxOrigin
      })
      postsContainer.appendChild(postCard.getElement())
    })
  }

  private renderTrendingTags(tags: Array<{ tag: string; post_count: number }>): void {
    const trendingContainer = this.element.querySelector('.explore-trending') as HTMLElement
    if (!trendingContainer) return

    trendingContainer.innerHTML = ''

    if (tags.length === 0) {
      trendingContainer.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--text-muted); font-family: monospace;">
          No trending tags yet
        </div>
      `
      return
    }

    tags.forEach(({ tag, post_count }) => {
      const item = document.createElement('div')
      item.className = 'trending-item'
      item.style.cssText = `
        padding: 1rem;
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        transition: background-color 0.2s ease;
      `
      
      item.innerHTML = `
        <div style="font-family: monospace; color: var(--accent); font-size: 1rem; font-weight: 600; margin-bottom: 0.25rem;"># ${tag}</div>
        <div style="font-family: monospace; color: var(--text-muted); font-size: 0.875rem;">${post_count} posts</div>
      `

      item.onmouseover = () => item.style.background = 'var(--bg-secondary)'
      item.onmouseout = () => item.style.background = 'transparent'
      
      item.onclick = () => {
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`)
        window.location.reload()
      }

      trendingContainer.appendChild(item)
    })
  }

  private updateLoadingState(isLoading: boolean): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement
    if (loadingElement) {
      loadingElement.style.display = isLoading ? 'block' : 'none'
      if (isLoading) {
        loadingElement.innerHTML = '<span>Loading...</span>'
      }
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    // Cleanup
    window.removeEventListener('scroll', () => {})
  }
}

// Factory function for easier usage
export function createExplorePage(props: ExplorePageProps): ExplorePage {
  return new ExplorePage(props)
}
