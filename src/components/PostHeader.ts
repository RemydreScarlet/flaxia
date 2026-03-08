import { PostHeaderProps } from '../types/post.js'

export function createPostHeader(props: PostHeaderProps): HTMLElement {
  const header = document.createElement('div')
  header.className = 'post-header'
  
  const avatar = document.createElement('div')
  avatar.className = 'post-avatar'
  avatar.style.cursor = 'pointer'
  avatar.style.width = '40px'
  avatar.style.height = '40px'
  avatar.style.borderRadius = '50%'
  avatar.style.display = 'flex'
  avatar.style.alignItems = 'center'
  avatar.style.justifyContent = 'center'
  avatar.style.fontSize = '1.2rem'
  avatar.style.color = 'white'
  avatar.style.background = 'var(--accent)'
  avatar.style.flexShrink = '0'
  
  // Show avatar image if available, otherwise show initial
  if (props.avatar_key) {
    avatar.style.backgroundImage = `url(/api/images/${props.avatar_key})`
    avatar.style.backgroundSize = 'cover'
    avatar.style.backgroundPosition = 'center'
    avatar.textContent = ''
  } else {
    avatar.textContent = props.username.charAt(0).toUpperCase()
  }
  
  const displayName = document.createElement('span')
  displayName.className = 'post-display-name'
  displayName.textContent = props.display_name || props.username
  displayName.style.cursor = 'pointer'
  displayName.style.fontWeight = 'bold'
  
  const username = document.createElement('span')
  username.className = 'post-username'
  username.textContent = `@${props.username}`
  username.style.cursor = 'pointer'
  username.style.color = 'var(--text-muted)'
  username.style.marginLeft = '0.5rem'
  
  const timestamp = document.createElement('span')
  timestamp.className = 'post-timestamp'
  timestamp.textContent = formatTimestamp(props.createdAt)
  
  header.appendChild(avatar)
  header.appendChild(displayName)
  header.appendChild(username)
  header.appendChild(timestamp)
  
  // Make avatar and names clickable to navigate to profile
  const navigateToProfile = () => {
    window.history.pushState({}, '', `/profile/${props.username}`)
    const event = new PopStateEvent('popstate', { state: {} })
    window.dispatchEvent(event)
  }
  
  avatar.addEventListener('click', (e) => {
    e.stopPropagation()
    navigateToProfile()
  })
  
  displayName.addEventListener('click', (e) => {
    e.stopPropagation()
    navigateToProfile()
  })
  
  username.addEventListener('click', (e) => {
    e.stopPropagation()
    navigateToProfile()
  })
  
  return header
}

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffMins < 1) return 'now'
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 7) return `${diffDays}d`
  
  return date.toLocaleDateString()
}
