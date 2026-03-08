export interface RightPanelProps {
  onSearch?: (query: string) => void
  onFollowUser?: (userId: string) => void
}

export class RightPanel {
  private element: HTMLElement
  private props: RightPanelProps
  private trendingTags: Array<{ tag: string; post_count: number }> = []

  constructor(props: RightPanelProps = {}) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
    this.loadTrendingTags()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('aside')
    container.className = 'right-panel'

    // Search box
    const searchSection = this.createSearchSection()
    container.appendChild(searchSection)

    // Trending hashtags
    const trendingSection = this.createTrendingSection()
    container.appendChild(trendingSection)

    // Who to follow
    const followSection = this.createFollowSection()
    container.appendChild(followSection)

    return container
  }

  private createSearchSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'search-section'
    
    section.innerHTML = `
      <div class="search-box">
        <input 
          type="text" 
          class="search-input" 
          placeholder="Search Flaxia"
        />
        <span class="search-icon">🔍</span>
      </div>
    `

    return section
  }

  private createTrendingSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'trending-section'
    
    section.innerHTML = `
      <h3 class="section-title">Trending</h3>
      <div class="trending-list">
        <div class="trending-loading" style="text-align: center; padding: 20px; color: var(--text-muted);">Loading...</div>
      </div>
    `

    return section
  }

  private createFollowSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'follow-section'
    
    section.innerHTML = `
      <h3 class="section-title">Who to follow</h3>
      <div class="follow-list">
        <div class="follow-item" data-user-id="user1">
          <div class="follow-avatar" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">A</div>
          <div class="follow-info">
            <div class="follow-name">Alice</div>
            <div class="follow-handle">@alice</div>
          </div>
          <button class="follow-button">Follow</button>
        </div>
        <div class="follow-item" data-user-id="user2">
          <div class="follow-avatar" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">B</div>
          <div class="follow-info">
            <div class="follow-name">Bob</div>
            <div class="follow-handle">@bob</div>
          </div>
          <button class="follow-button">Follow</button>
        </div>
        <div class="follow-item" data-user-id="user3">
          <div class="follow-avatar" style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);">C</div>
          <div class="follow-info">
            <div class="follow-name">Carol</div>
            <div class="follow-handle">@carol</div>
          </div>
          <button class="follow-button">Follow</button>
        </div>
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

    // Follow buttons
    const followButtons = this.element.querySelectorAll('.follow-button')
    followButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault()
        const userId = (button as HTMLElement).dataset.userId
        if (userId) {
          this.props.onFollowUser?.(userId)
        }
      })
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

  private async loadTrendingTags(): Promise<void> {
    try {
      const response = await fetch('/api/tags/trending')
      if (!response.ok) {
        throw new Error('Failed to load trending tags')
      }

      const data = await response.json() as { tags: Array<{ tag: string; post_count: number }> }
      this.trendingTags = data.tags || []
      this.renderTrendingTags()
    } catch (error) {
      console.error('Failed to load trending tags:', error)
    }
  }

  private renderTrendingTags(): void {
    const trendingList = this.element.querySelector('.trending-list')
    if (!trendingList) return

    trendingList.innerHTML = ''

    if (this.trendingTags.length === 0) {
      const emptyState = document.createElement('div')
      emptyState.style.cssText = 'padding: 20px; color: var(--text-muted); text-align: center;'
      emptyState.textContent = 'No trending tags yet'
      trendingList.appendChild(emptyState)
      return
    }

    this.trendingTags.forEach(({ tag, post_count }) => {
      const item = document.createElement('div')
      item.className = 'trending-item'
      item.style.cssText = `
        padding: 12px 0;
        cursor: pointer;
        transition: background 0.2s ease;
      `
      
      item.innerHTML = `
        <div class="trending-content">
          <div class="trending-hashtag" style="font-family: monospace; color: var(--accent); font-size: 15px; font-weight: 600;"># ${tag}</div>
          <div class="trending-count" style="font-family: monospace; color: var(--text-muted); font-size: 13px;">${post_count} posts</div>
        </div>
      `

      item.addEventListener('click', () => {
        window.location.href = `/explore?tag=${encodeURIComponent(tag)}`
      })

      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--bg-secondary)'
      })

      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent'
      })

      trendingList.appendChild(item)
    })
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    this.element.remove()
  }
}

// Factory function for easier usage
export function createRightPanel(props: RightPanelProps = {}): RightPanel {
  return new RightPanel(props)
}
