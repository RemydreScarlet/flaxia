export interface TrendingModalProps {
  onClose: () => void
  onTagClick: (tag: string) => void
}

export function createTrendingModal(props: TrendingModalProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'trending-modal-overlay'
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  `

  const modal = document.createElement('div')
  modal.className = 'trending-modal'
  modal.style.cssText = `
    background: var(--bg-primary);
    border-radius: 0.5rem;
    max-width: 400px;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `

  // Header
  const header = document.createElement('div')
  header.className = 'trending-modal-header'
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  `

  const title = document.createElement('h3')
  title.textContent = 'Trending'
  title.style.cssText = `
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
  `

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '✕'
  closeBtn.style.cssText = `
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.25rem;
  `
  closeBtn.onclick = props.onClose

  header.appendChild(title)
  header.appendChild(closeBtn)

  // Content
  const content = document.createElement('div')
  content.className = 'trending-modal-content'
  content.style.cssText = `
    padding: 1rem;
  `

  // Loading state
  content.innerHTML = `
    <div style="text-align: center; padding: 2rem; color: var(--text-muted);">
      Loading trending topics...
    </div>
  `

  // Load trending data
  loadTrendingTags(content, props.onTagClick)

  modal.appendChild(header)
  modal.appendChild(content)
  container.appendChild(modal)

  // Close on overlay click
  container.onclick = (e) => {
    if (e.target === container) {
      props.onClose()
    }
  }

  return container
}

async function loadTrendingTags(container: HTMLElement, onTagClick: (tag: string) => void): Promise<void> {
  try {
    const response = await fetch('/api/tags/trending')
    if (!response.ok) {
      throw new Error('Failed to load trending tags')
    }

    const data = await response.json() as { tags: Array<{ tag: string; post_count: number }> }
    const tags = data.tags || []

    container.innerHTML = ''

    if (tags.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--text-muted); font-family: monospace;">
          No trending tags yet
        </div>
      `
      return
    }

    tags.forEach(({ tag, post_count }) => {
      const item = document.createElement('div')
      item.className = 'trending-modal-item'
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
        onTagClick(tag)
      }

      container.appendChild(item)
    })

  } catch (error) {
    console.error('Failed to load trending tags:', error)
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: var(--danger); font-family: monospace;">
        Failed to load trending topics
      </div>
    `
  }
}
