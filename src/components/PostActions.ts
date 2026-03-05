import { PostActionsProps } from '../types/post.js'

export function createPostActions(props: PostActionsProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'post-actions'
  
  // Fresh! button
  const freshButton = createActionButton('fresh', props.freshCount.toString(), props.isFreshed)
  freshButton.addEventListener('click', props.onFreshToggle)
  
  // Reply button
  const replyButton = createActionButton('reply', '0', false)
  replyButton.addEventListener('click', () => {
    // TODO: Implement reply functionality
    console.log('Reply clicked for post:', props.postId)
  })
  
  // Share button
  const shareButton = createActionButton('share', '0', false)
  shareButton.addEventListener('click', () => {
    // TODO: Implement share functionality
    console.log('Share clicked for post:', props.postId)
  })
  
  container.appendChild(freshButton)
  container.appendChild(replyButton)
  container.appendChild(shareButton)
  
  return container
}

function createActionButton(type: 'fresh' | 'reply' | 'share', count: string, isActive: boolean): HTMLElement {
  const button = document.createElement('button')
  button.className = `action-button action-button--${type}`
  button.setAttribute('aria-label', `${type} post`)
  
  if (isActive) {
    button.classList.add('action-button--active')
  }
  
  // Create icon (using text for now, will replace with Lucide icons)
  const icon = document.createElement('span')
  icon.className = 'action-icon'
  icon.textContent = getIconForType(type)
  
  // Create count
  const countSpan = document.createElement('span')
  countSpan.className = 'action-count'
  countSpan.textContent = count
  
  button.appendChild(icon)
  button.appendChild(countSpan)
  
  return button
}

function getIconForType(type: 'fresh' | 'reply' | 'share'): string {
  switch (type) {
    case 'fresh':
      return '🍃' // Leaf emoji for Fresh!
    case 'reply':
      return '💬' // Message emoji for Reply
    case 'share':
      return '🔗' // Link emoji for Share
    default:
      return ''
  }
}
