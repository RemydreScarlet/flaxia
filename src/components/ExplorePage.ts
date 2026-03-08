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

    if (this.props.tag) {
      // Tag view
      container.innerHTML = `
        <div class="explore-header">
          <h1 class="explore-title"># ${this.props.tag}</h1>
        </div>
        <div class="explore-posts"></div>
        <div class="explore-loading" style="display: none;">
          <span>Loading...</span>
        </div>
      `
    } else {
      // Trending view
      container.innerHTML = `
        <div class="explore-header">
          <h1 class="explore-title">Explore</h1>
        </div>
        <div class="explore-trending"></div>
        <div class="explore-loading" style="display: none;">
          <span>Loading...</span>
        </div>
      `
    }

    return container
  }

  private setupEventListeners(): void {
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

  private async loadPosts(): Promise<void> {
    if (this.loading) return

    this.loading = true
    this.updateLoadingState(true)

    try {
      if (this.props.tag) {
        // Load posts with this tag
        let url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag)}&limit=20`
        if (this.cursor) {
          url += `&cursor=${encodeURIComponent(this.cursor)}`
        }

        const response = await fetch(url)
        if (!response.ok) {
          throw new Error('Failed to load posts')
        }

        const data = await response.json() as { posts: Post[] }
        this.posts = data.posts || []
        this.hasMore = this.posts.length > 0
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
      const url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag)}&limit=20&cursor=${encodeURIComponent(this.cursor || '')}`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error('Failed to load more posts')
      }

      const data = await response.json() as { posts: Post[] }
      const newPosts = data.posts || []
      this.posts = [...this.posts, ...newPosts]
      this.hasMore = newPosts.length > 0
      this.cursor = newPosts.length > 0 ? newPosts[newPosts.length - 1].created_at : undefined

      this.renderPosts()
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
      this.renderTrendingTags(data.tags || [])
    } catch (error) {
      console.error('Failed to load trending tags:', error)
    }
  }

  private renderPosts(): void {
    const postsContainer = this.element.querySelector('.explore-posts')!
    postsContainer.innerHTML = ''

    this.posts.forEach(post => {
      const postCard = createPostCard({
        post,
        sandboxOrigin: this.props.sandboxOrigin
      })
      postsContainer.appendChild(postCard.getElement())
    })

    if (this.posts.length === 0) {
      const emptyState = document.createElement('div')
      emptyState.className = 'explore-empty'
      emptyState.style.cssText = `
        text-align: center;
        padding: 40px;
        color: var(--text-muted);
      `
      emptyState.textContent = `No posts found for #${this.props.tag}`
      postsContainer.appendChild(emptyState)
    }
  }

  private renderTrendingTags(tags: Array<{ tag: string; post_count: number }>): void {
    const trendingContainer = this.element.querySelector('.explore-trending')!
    trendingContainer.innerHTML = ''

    if (tags.length === 0) {
      const emptyState = document.createElement('div')
      emptyState.style.cssText = `
        text-align: center;
        padding: 40px;
        color: var(--text-muted);
      `
      emptyState.textContent = 'No trending tags yet'
      trendingContainer.appendChild(emptyState)
      return
    }

    tags.forEach(({ tag, post_count }) => {
      const tagCard = document.createElement('a')
      tagCard.href = `/explore?tag=${encodeURIComponent(tag)}`
      tagCard.style.cssText = `
        display: block;
        padding: 16px;
        border-bottom: 1px solid var(--border);
        text-decoration: none;
        transition: background 0.2s ease;
      `

      tagCard.innerHTML = `
        <div class="trending-tag" style="font-family: monospace; color: var(--accent); font-size: 18px; margin-bottom: 4px;"># ${tag}</div>
        <div class="trending-count" style="font-family: monospace; color: var(--text-muted); font-size: 14px;">${post_count} posts</div>
      `

      tagCard.addEventListener('mouseenter', () => {
        tagCard.style.background = 'var(--bg-secondary)'
      })

      tagCard.addEventListener('mouseleave', () => {
        tagCard.style.background = 'transparent'
      })

      trendingContainer.appendChild(tagCard)
    })
  }

  private updateLoadingState(isLoading: boolean): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement
    if (loadingElement) {
      loadingElement.style.display = isLoading ? 'block' : 'none'
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    this.element.remove()
  }
}

export function createExplorePage(props: ExplorePageProps): ExplorePage {
  return new ExplorePage(props)
}
