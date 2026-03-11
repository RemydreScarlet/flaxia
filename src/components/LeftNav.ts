export interface LeftNavProps {
  activeItem?: string
  unreadCount?: number
  onNavigate?: (item: string) => void
  currentUser?: {
    id: string
    username: string
    display_name?: string
    avatar_key?: string
  }
}

export class LeftNav {
  private element: HTMLElement
  private props: LeftNavProps
  private activeItem: string
  private userAreaElement: HTMLElement | null = null
  private popupMenuElement: HTMLElement | null = null
  private isPopupMenuOpen = false

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

      // Base content
      let itemContent = `<span style="margin-right: 0.75rem;">${item.icon}</span><span>${item.label}</span>`

      // Add badge for notifications
      if (item.id === 'notifications' && this.props.unreadCount && this.props.unreadCount > 0) {
        itemContent += `<span class="nav-badge" style="
          margin-left: auto;
          background: var(--accent);
          color: #000;
          font-family: monospace;
          font-size: 12px;
          padding: 2px 8px;
          border-radius: 9999px;
          min-width: 20px;
          text-align: center;
        ">${this.props.unreadCount}</span>`
      }

      navItem.innerHTML = itemContent
      navItems.appendChild(navItem)
    })

    // Post button
    const postButton = document.createElement('button')
    postButton.className = 'nav-post-button'
    postButton.innerHTML = 'Post'

    nav.appendChild(logo)
    nav.appendChild(navItems)
    nav.appendChild(postButton)

    // Add user area at the bottom if current user is available
    if (this.props.currentUser) {
      this.userAreaElement = this.createUserArea()
      nav.appendChild(this.userAreaElement)
      
      // Check if mobile and hide user area
      if (window.innerWidth <= 768) {
        this.userAreaElement.style.display = 'none'
      }
    }

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

    // User area click handler
    if (this.userAreaElement) {
      this.userAreaElement.addEventListener('click', (e) => {
        e.stopPropagation()
        this.togglePopupMenu()
      })
    }

    // Close popup when clicking outside
    document.addEventListener('click', (e) => {
      if (this.isPopupMenuOpen && !this.popupMenuElement?.contains(e.target as Node)) {
        this.closePopupMenu()
      }
    })

    // Handle window resize for mobile detection
    window.addEventListener('resize', () => {
      if (this.userAreaElement) {
        if (window.innerWidth <= 768) {
          this.userAreaElement.style.display = 'none'
        } else {
          this.userAreaElement.style.display = 'flex'
        }
      }
    })
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

  public setUnreadCount(count: number): void {
    const notificationsItem = this.element.querySelector('[data-nav-id="notifications"]')
    if (!notificationsItem) return

    let badge = notificationsItem.querySelector('.nav-badge')

    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'nav-badge'
        badge.setAttribute('style', `
          margin-left: auto;
          background: var(--accent);
          color: #000;
          font-family: monospace;
          font-size: 12px;
          padding: 2px 8px;
          border-radius: 9999px;
          min-width: 20px;
          text-align: center;
        `)
        notificationsItem.appendChild(badge)
      }
      badge.textContent = count.toString()
    } else {
      badge?.remove()
    }
  }

  public destroy(): void {
    this.element.remove()
    this.closePopupMenu()
  }

  private createUserArea(): HTMLElement {
    const userArea = document.createElement('div')
    userArea.className = 'nav-user-area'
    userArea.setAttribute('style', `
      margin-top: auto;
      padding: 0.75rem;
      border-radius: 9999px;
      cursor: pointer;
      transition: background-color 0.2s;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    `)

    const user = this.props.currentUser!
    const avatarUrl = user.avatar_key ? `/api/images/${user.avatar_key}` : '/api/images/default-avatar'
    const displayName = user.display_name || user.username

    userArea.innerHTML = `
      <img src="${avatarUrl}" alt="${displayName}" style="
        width: 40px;
        height: 40px;
        border-radius: 50%;
        object-fit: cover;
      " onerror="this.src='/api/images/default-avatar'">
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayName}</div>
        <div style="color: var(--text-muted); font-family: monospace; font-size: 0.875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">@${user.username}</div>
      </div>
      <div style="color: var(--text-muted); font-size: 1.25rem;">⋯</div>
    `

    // Add hover effect
    userArea.addEventListener('mouseenter', () => {
      userArea.style.backgroundColor = 'var(--bg-secondary)'
    })
    userArea.addEventListener('mouseleave', () => {
      userArea.style.backgroundColor = 'transparent'
    })

    return userArea
  }

  private togglePopupMenu(): void {
    if (this.isPopupMenuOpen) {
      this.closePopupMenu()
    } else {
      this.openPopupMenu()
    }
  }

  private openPopupMenu(): void {
    if (!this.userAreaElement) return

    this.closePopupMenu() // Close any existing popup

    const popup = document.createElement('div')
    popup.className = 'nav-popup-menu'
    popup.setAttribute('style', `
      position: fixed;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.5rem;
      z-index: 1000;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    `)

    const logoutItem = document.createElement('button')
    logoutItem.setAttribute('style', `
      width: 100%;
      padding: 0.5rem 0.75rem;
      background: transparent;
      border: none;
      text-align: left;
      color: var(--text-primary);
      cursor: pointer;
      border-radius: 2px;
      font-size: 0.875rem;
      transition: background-color 0.2s;
    `)
    logoutItem.textContent = `Log out @${this.props.currentUser!.username}`

    logoutItem.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closePopupMenu()
      this.showLogoutConfirmation()
    })

    logoutItem.addEventListener('mouseenter', () => {
      logoutItem.style.backgroundColor = 'var(--bg-secondary)'
    })
    logoutItem.addEventListener('mouseleave', () => {
      logoutItem.style.backgroundColor = 'transparent'
    })

    popup.appendChild(logoutItem)

    // Position the popup relative to the user area
    const userAreaRect = this.userAreaElement.getBoundingClientRect()
    
    popup.style.bottom = `${window.innerHeight - userAreaRect.top + 8}px`
    popup.style.left = `${userAreaRect.left}px`
    popup.style.width = `${userAreaRect.width}px`

    document.body.appendChild(popup)
    this.popupMenuElement = popup
    this.isPopupMenuOpen = true
  }

  private closePopupMenu(): void {
    if (this.popupMenuElement) {
      this.popupMenuElement.remove()
      this.popupMenuElement = null
    }
    this.isPopupMenuOpen = false
  }

  private showLogoutConfirmation(): void {
    const user = this.props.currentUser!
    
    // Create modal overlay
    const overlay = document.createElement('div')
    overlay.setAttribute('style', `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    `)

    // Create modal content
    const modal = document.createElement('div')
    modal.setAttribute('style', `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      max-width: 320px;
      width: 90%;
      text-align: center;
    `)

    modal.innerHTML = `
      <h3 style="margin: 0 0 1rem 0; color: var(--text-primary); font-size: 1.125rem;">Log out of @${user.username}?</h3>
      <div style="display: flex; gap: 0.75rem; justify-content: center;">
        <button class="logout-cancel-btn" style="
          padding: 0.5rem 1rem;
          background: var(--bg-secondary);
          color: var(--text-primary);
          border: 1px solid var(--border);
          border-radius: 9999px;
          cursor: pointer;
          font-size: 0.875rem;
          transition: background-color 0.2s;
        ">Cancel</button>
        <button class="logout-confirm-btn" style="
          padding: 0.5rem 1rem;
          background: var(--text-primary);
          color: var(--bg-primary);
          border: none;
          border-radius: 9999px;
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 600;
          transition: opacity 0.2s;
        ">Log out</button>
      </div>
    `

    // Add event listeners
    const cancelBtn = modal.querySelector('.logout-cancel-btn') as HTMLButtonElement
    const confirmBtn = modal.querySelector('.logout-confirm-btn') as HTMLButtonElement

    cancelBtn.addEventListener('click', () => {
      overlay.remove()
    })

    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.backgroundColor = 'var(--bg-tertiary)'
    })
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.backgroundColor = 'var(--bg-secondary)'
    })

    confirmBtn.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include'
        })
        
        if (response.ok) {
          // Redirect to home page
          window.location.href = '/'
        } else {
          console.error('Logout failed')
          overlay.remove()
        }
      } catch (error) {
        console.error('Logout error:', error)
        overlay.remove()
      }
    })

    confirmBtn.addEventListener('mouseenter', () => {
      confirmBtn.style.opacity = '0.8'
    })
    confirmBtn.addEventListener('mouseleave', () => {
      confirmBtn.style.opacity = '1'
    })

    // Close modal when clicking overlay
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove()
      }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
  }
}

// Factory function for easier usage
export function createLeftNav(props: LeftNavProps = {}): LeftNav {
  return new LeftNav(props)
}

// Update function to handle user changes
export function updateLeftNavUser(leftNav: LeftNav, currentUser: {
  id: string
  username: string
  display_name?: string
  avatar_key?: string
} | null): void {
  // Update the props
  ;(leftNav as any).props.currentUser = currentUser
  
  // Remove existing user area if present
  const existingUserArea = leftNav.getElement().querySelector('.nav-user-area')
  if (existingUserArea) {
    existingUserArea.remove()
  }
  
    // Add new user area if user is available
  if (currentUser) {
    const userAreaElement = (leftNav as any).createUserArea()
    leftNav.getElement().appendChild(userAreaElement)
    ;(leftNav as any).userAreaElement = userAreaElement
    
    // Check if mobile and hide user area
    if (window.innerWidth <= 768) {
      userAreaElement.style.display = 'none'
    }
    
    // Re-setup event listeners for the new user area
    userAreaElement.addEventListener('click', (e: Event) => {
      e.stopPropagation()
      ;(leftNav as any).togglePopupMenu()
    })
  }
}
