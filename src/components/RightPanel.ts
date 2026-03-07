export interface RightPanelProps {
  onSearch?: (query: string) => void
  onFollowUser?: (userId: string) => void
}

export class RightPanel {
  private element: HTMLElement
  private props: RightPanelProps

  constructor(props: RightPanelProps = {}) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
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
      <h3 class="section-title">Trending hashtags</h3>
      <div class="trending-list">
        <div class="trending-item">
          <div class="trending-content">
            <div class="trending-hashtag">#webgpu</div>
            <div class="trending-count">1,234 posts</div>
          </div>
        </div>
        <div class="trending-item">
          <div class="trending-content">
            <div class="trending-hashtag">#creativecoding</div>
            <div class="trending-count">856 posts</div>
          </div>
        </div>
        <div class="trending-item">
          <div class="trending-content">
            <div class="trending-hashtag">#generativeart</div>
            <div class="trending-count">642 posts</div>
          </div>
        </div>
        <div class="trending-item">
          <div class="trending-content">
            <div class="trending-hashtag">#javascript</div>
            <div class="trending-count">523 posts</div>
          </div>
        </div>
        <div class="trending-item">
          <div class="trending-content">
            <div class="trending-hashtag">#wasm</div>
            <div class="trending-count">387 posts</div>
          </div>
        </div>
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
        const query = (e.target as HTMLInputElement).value
        this.props.onSearch?.(query)
      })

      searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const query = searchInput.value.trim()
          if (query) {
            this.props.onSearch?.(query)
          }
        }
      })
    }

    // Follow buttons
    this.element.querySelectorAll('.follow-button').forEach(button => {
      button.addEventListener('click', (e) => {
        const followItem = (e.target as HTMLElement).closest('.follow-item')
        const userId = followItem?.getAttribute('data-user-id')
        if (userId) {
          this.props.onFollowUser?.(userId)
          
          // Update button state
          const btn = e.target as HTMLButtonElement
          if (btn.textContent === 'Follow') {
            btn.textContent = 'Following'
            btn.style.background = 'var(--accent)'
            btn.style.color = '#000'
          } else {
            btn.textContent = 'Follow'
            btn.style.background = 'transparent'
            btn.style.color = 'var(--accent)'
          }
        }
      })
    })

    // Trending hashtags
    this.element.querySelectorAll('.trending-item').forEach(item => {
      item.addEventListener('click', () => {
        const hashtag = item.querySelector('.trending-hashtag')?.textContent
        if (hashtag) {
          this.props.onSearch?.(hashtag)
        }
      })
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
