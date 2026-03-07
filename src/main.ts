import { createTimeline } from './components/Timeline.js'
import { createLeftNav } from './components/LeftNav.js'
import { createRightPanel } from './components/RightPanel.js'
import { createThreadPage } from './components/ThreadPage.js'
import { logout } from './lib/auth.js'

console.log('Flaxia initialized')

// Basic app initialization
document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app')
  if (app) {
    console.log('App mounted')
    
    // Routing state
    let currentView: 'timeline' | 'thread' = 'timeline'
    let currentPostId: string | null = null
    let timeline: ReturnType<typeof createTimeline> | null = null
    let threadPage: ReturnType<typeof createThreadPage> | null = null
    
    // Parse current URL
    const parseCurrentRoute = () => {
      const path = window.location.pathname
      console.log('Current path:', path, 'Full URL:', window.location.href)
      
      // Remove trailing slash and ensure consistent format
      const cleanPath = path.replace(/\/$/, '')
      console.log('Clean path:', cleanPath)
      
      const threadMatch = cleanPath.match(/^\/posts\/([^\/]+)$/)
      if (threadMatch) {
        console.log('Thread route detected, postId:', threadMatch[1])
        return { view: 'thread' as const, postId: threadMatch[1] }
      }
      console.log('Timeline route detected')
      return { view: 'timeline' as const, postId: null }
    }
    
    // Navigate to view
    const navigateTo = (view: 'timeline' | 'thread', postId?: string) => {
      console.log('Navigate to:', view, postId, 'Current view:', currentView)
      
      // Cleanup current view
      if (timeline) {
        console.log('Cleaning up timeline')
        timeline.destroy()
        timeline = null
      }
      if (threadPage) {
        console.log('Cleaning up thread page')
        threadPage.destroy()
        threadPage = null
      }
      
      // Clear app content
      app.innerHTML = ''
      
      // Create main container
      const mainContainer = document.createElement('div')
      mainContainer.className = 'main-container'
      
      if (view === 'thread' && postId) {
        // Thread page view
        console.log('Creating thread page for postId:', postId)
        currentView = 'thread'
        currentPostId = postId
        
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxiausercontent.com'
        threadPage = createThreadPage({
          postId,
          sandboxOrigin,
          onBack: () => {
            console.log('Back button clicked, navigating to timeline')
            window.history.pushState({}, '', '/')
            navigateTo('timeline')
          }
        })
        
        console.log('Thread page created, adding to container')
        mainContainer.appendChild(threadPage.getElement())
        console.log('Thread page added to DOM')
      } else {
        // Timeline view
        currentView = 'timeline'
        currentPostId = null
        
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
        timeline = createTimeline({
          sandboxOrigin
        })
        
        // Listen for navigation events from timeline
        timeline.getElement().addEventListener('navigateToThread', (e: any) => {
          const postId = e.detail.postId
          window.history.pushState({ postId }, '', `/posts/${postId}`)
          navigateTo('thread', postId)
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
      }
      
      app.appendChild(mainContainer)
    }
    
    // Handle browser back/forward
    window.addEventListener('popstate', (e) => {
      const route = parseCurrentRoute()
      navigateTo(route.view, route.postId || undefined)
    })
    
    // Initial navigation
    console.log('DOM Content Loaded, starting initial routing...')
    const initialRoute = parseCurrentRoute()
    console.log('Initial route:', initialRoute)
    navigateTo(initialRoute.view, initialRoute.postId || undefined)
  }
})
