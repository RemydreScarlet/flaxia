import { createTimeline } from './components/Timeline.js'
import { createLeftNav } from './components/LeftNav.js'
import { createRightPanel } from './components/RightPanel.js'
import { logout } from './lib/auth.js'

console.log('Flaxia initialized')

// Basic app initialization
document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app')
  if (app) {
    console.log('App mounted')
    
    // Clear existing content
    app.innerHTML = ''
    
    // Create main container
    const mainContainer = document.createElement('div')
    mainContainer.className = 'main-container'
    
    // Create Left Nav
    const leftNav = createLeftNav({
      activeItem: 'home',
      onNavigate: (item) => {
        console.log('Navigate to:', item)
        // Handle navigation here
      }
    })
    
    // Create Timeline
    const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxiausercontent.com'
    const timeline = createTimeline({
      sandboxOrigin
    })
    
    // Create Right Panel
    const rightPanel = createRightPanel({
      onSearch: (query) => {
        console.log('Search:', query)
        // Handle search here
      },
      onFollowUser: (userId) => {
        console.log('Follow user:', userId)
        // Handle follow here
      }
    })
    
    // Assemble layout
    mainContainer.appendChild(leftNav.getElement())
    mainContainer.appendChild(timeline.getElement())
    mainContainer.appendChild(rightPanel.getElement())
    
    app.appendChild(mainContainer)
  }
})
