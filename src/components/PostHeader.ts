import { PostHeaderProps } from '../types/post.js'

export function createPostHeader(props: PostHeaderProps): HTMLElement {
  const header = document.createElement('div')
  header.className = 'post-header'
  
  const avatar = document.createElement('div')
  avatar.className = 'post-avatar'
  avatar.textContent = props.username.charAt(0).toUpperCase()
  avatar.style.cursor = 'pointer'
  
  const username = document.createElement('span')
  username.className = 'post-username'
  username.textContent = props.username
  username.style.cursor = 'pointer'
  
  const timestamp = document.createElement('span')
  timestamp.className = 'post-timestamp'
  timestamp.textContent = formatTimestamp(props.createdAt)
  
  header.appendChild(avatar)
  header.appendChild(username)
  header.appendChild(timestamp)
  
  // Make avatar and username clickable to navigate to profile
  const navigateToProfile = () => {
    window.history.pushState({}, '', `/profile/${props.username}`)
    const event = new PopStateEvent('popstate', { state: {} })
    window.dispatchEvent(event)
  }
  
  avatar.addEventListener('click', (e) => {
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
