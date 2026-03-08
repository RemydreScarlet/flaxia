export interface LeftNavProps {
  activeItem?: string
  onNavigate?: (item: string) => void
}

export class LeftNav {
  private element: HTMLElement
  private props: LeftNavProps
  private activeItem: string

  constructor(props: LeftNavProps = {}) {
    this.props = props
    this.activeItem = props.activeItem || 'home'
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const nav = document.createElement('nav')
    nav.className = 'left-nav'

    // Logo section
    const logo = document.createElement('div')
    logo.className = 'nav-logo'
    logo.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 2rem;">
        <span style="font-size: 1.5rem;">🌿</span>
        <span style="font-size: 1.25rem; font-weight: 600; color: var(--accent);">Flaxia</span>
      </div>
    `

    // Navigation items
    const navItems = document.createElement('div')
    navItems.className = 'nav-items'
    
    const items = [
      { id: 'home', label: 'Home', icon: '🏠' },
      { id: 'explore', label: 'Explore', icon: '🔍' },
      { id: 'trending', label: 'Trending', icon: '📈' },
      { id: 'notifications', label: 'Notifications', icon: '🔔' },
      { id: 'profile', label: 'Profile', icon: '👤' }
    ]

    items.forEach(item => {
      const navItem = document.createElement('button')
      navItem.className = `nav-item ${this.activeItem === item.id ? 'nav-item--active' : ''}`
      navItem.setAttribute('data-nav-id', item.id)
      navItem.innerHTML = `
        <span style="margin-right: 0.75rem;">${item.icon}</span>
        <span>${item.label}</span>
      `
      navItems.appendChild(navItem)
    })

    // Post button
    const postButton = document.createElement('button')
    postButton.className = 'nav-post-button'
    postButton.innerHTML = 'Post'

    nav.appendChild(logo)
    nav.appendChild(navItems)
    nav.appendChild(postButton)

    return nav
  }

  private setupEventListeners(): void {
    // Navigation items
    this.element.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement
        const navId = target.getAttribute('data-nav-id')
        if (navId) {
          this.setActiveItem(navId)
          this.props.onNavigate?.(navId)
        }
      })
    })

    // Post button
    const postButton = this.element.querySelector('.nav-post-button')
    if (postButton) {
      postButton.addEventListener('click', () => {
        this.props.onNavigate?.('post')
      })
    }
  }

  public setActiveItem(item: string): void {
    this.activeItem = item
    
    // Update active state
    this.element.querySelectorAll('.nav-item').forEach(navItem => {
      const navId = navItem.getAttribute('data-nav-id')
      if (navId === item) {
        navItem.classList.add('nav-item--active')
      } else {
        navItem.classList.remove('nav-item--active')
      }
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
export function createLeftNav(props: LeftNavProps = {}): LeftNav {
  return new LeftNav(props)
}
