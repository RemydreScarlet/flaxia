import { createTimeline } from './components/Timeline.js'
import { createLeftNav } from './components/LeftNav.js'
import { createRightPanel } from './components/RightPanel.js'
import { createThreadPage } from './components/ThreadPage.js'
import { createLoginPage } from './components/LoginPage.js'
import { createRegisterPage } from './components/RegisterPage.js'
import { createProfilePage } from './components/ProfilePage.js'
import { logout } from './lib/auth.js'

console.log('Flaxia initialized')

// Basic app initialization
document.addEventListener('DOMContentLoaded', async () => {
  const app = document.getElementById('app')
  if (app) {
    console.log('App mounted')
    
    // Routing state
    let currentView: 'timeline' | 'thread' | 'login' | 'register' | 'profile' = 'timeline'
    let currentPostId: string | null = null
    let currentUsername: string | null = null
    let timeline: ReturnType<typeof createTimeline> | null = null
    let threadPage: ReturnType<typeof createThreadPage> | null = null
    let loginPage: ReturnType<typeof createLoginPage> | null = null
    let registerPage: ReturnType<typeof createRegisterPage> | null = null
    let profilePage: ReturnType<typeof createProfilePage> | null = null
    let currentUser: { username: string } | null = null
    
    // Check current user session
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/me')
        if (response.ok) {
          const data = await response.json() as { user: any }
          currentUser = { username: data.user.username }
          return true
        }
      } catch (error) {
        console.log('Not authenticated')
      }
      currentUser = null
      return false
    }

    // Auth guard - redirect to login if not authenticated
    const requireAuth = async () => {
      const isAuthenticated = await checkAuth()
      if (!isAuthenticated) {
        window.history.pushState({}, '', '/login')
        navigateTo('login')
        return false
      }
      return true
    }

    // Parse current URL
    const parseCurrentRoute = () => {
      const path = window.location.pathname
      console.log('Current path:', path, 'Full URL:', window.location.href)
      
      // Remove trailing slash and ensure consistent format
      const cleanPath = path.replace(/\/$/, '')
      console.log('Clean path:', cleanPath)
      
      // Auth routes
      if (cleanPath === '/login') {
        console.log('Login route detected')
        return { view: 'login' as const, postId: null, username: null }
      }
      
      if (cleanPath === '/register') {
        console.log('Register route detected')
        return { view: 'register' as const, postId: null, username: null }
      }
      
      // Thread route (check before profile)
      const threadMatch = cleanPath.match(/^\/posts\/([^\/]+)$/)
      if (threadMatch) {
        console.log('Thread route detected, postId:', threadMatch[1])
        return { view: 'thread' as const, postId: threadMatch[1], username: null }
      }
      
      // Profile route - matches /profile/:username
      const profileMatch = cleanPath.match(/^\/profile\/([^\/]+)$/)
      console.log('Profile match test:', profileMatch, 'cleanPath:', cleanPath)
      if (profileMatch && profileMatch[1]) {
        console.log('Profile route detected, username:', profileMatch[1])
        return { view: 'profile' as const, postId: null, username: profileMatch[1] }
      }
      
      // Default timeline (only for root path)
      if (cleanPath === '' || cleanPath === '/') {
        console.log('Timeline route detected')
        return { view: 'timeline' as const, postId: null, username: null }
      }
      
      // If no specific route matched, default to timeline
      console.log('Unknown route, defaulting to timeline')
      return { view: 'timeline' as const, postId: null, username: null }
    }
    
    // Navigate to view
    const navigateTo = async (view: 'timeline' | 'thread' | 'login' | 'register' | 'profile', postId?: string, username?: string) => {
      console.log('Navigate to:', view, postId, username, 'Current view:', currentView)
      
      // For auth routes, proceed directly
      if (view === 'login' || view === 'register') {
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
        if (loginPage) {
          loginPage.destroy()
          loginPage = null
        }
        if (registerPage) {
          registerPage.destroy()
          registerPage = null
        }
        if (profilePage) {
          profilePage.destroy()
          profilePage = null
        }
      } else {
        // Auth guard for protected routes
        const isAuthenticated = await requireAuth()
        if (!isAuthenticated) {
          return // Auth guard will redirect to login
        }
        
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
        if (loginPage) {
          loginPage.destroy()
          loginPage = null
        }
        if (registerPage) {
          registerPage.destroy()
          registerPage = null
        }
        if (profilePage) {
          profilePage.destroy()
          profilePage = null
        }
      }
      
      // Clear app content
      app.innerHTML = ''
      
      // Handle auth pages (full screen)
      if (view === 'login') {
        currentView = 'login'
        currentPostId = null
        currentUsername = null
        
        loginPage = createLoginPage({
          onSuccess: () => {
            window.history.pushState({}, '', '/home')
            navigateTo('timeline')
          }
        })
        
        app.appendChild(loginPage.getElement())
        return
      }
      
      if (view === 'register') {
        currentView = 'register'
        currentPostId = null
        currentUsername = null
        
        registerPage = createRegisterPage({
          onSuccess: () => {
            window.history.pushState({}, '', '/home')
            navigateTo('timeline')
          }
        })
        
        app.appendChild(registerPage.getElement())
        return
      }
      
      // Handle profile page (within 3-column layout)
      if (view === 'profile' && username) {
        currentView = 'profile'
        currentPostId = null
        currentUsername = username
        
        // Create main container for 3-column layout
        const mainContainer = document.createElement('div')
        mainContainer.className = 'main-container'
        
        // Create Left Nav
        const leftNav = createLeftNav({
          activeItem: 'profile',
          onNavigate: async (item) => {
            console.log('Navigate to:', item)
            if (item === 'profile') {
              if (!currentUser) {
                window.history.pushState({}, '', '/')
                navigateTo('timeline')
                return
              }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
          }
        })
        
        // Create Profile Page (as main content)
        profilePage = createProfilePage({
          username,
          currentUser
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
        mainContainer.appendChild(profilePage.getElement())
        mainContainer.appendChild(rightPanel.getElement())
        
        app.appendChild(mainContainer)
        return
      }
      
      // Create main container for timeline/thread views
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
          onNavigate: async (item) => {
            console.log('Navigate to:', item)
            if (item === 'profile') {
              if (!currentUser) {
                window.history.pushState({}, '', '/')
                navigateTo('timeline')
                return
              }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
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
    window.addEventListener('popstate', async (e) => {
      const route = parseCurrentRoute()
      await navigateTo(route.view, route.postId || undefined, route.username || undefined)
    })
    
    // Initial navigation
    console.log('DOM Content Loaded, starting initial routing...')
    const initialRoute = parseCurrentRoute()
    console.log('Initial route:', initialRoute)
    await navigateTo(initialRoute.view, initialRoute.postId || undefined, initialRoute.username || undefined)
  }
})
