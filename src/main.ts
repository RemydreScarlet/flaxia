import { createTimeline } from './components/Timeline.js'
import { logout } from './lib/auth.js'

console.log('Flaxia initialized')

// Basic app initialization
document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app')
  if (app) {
    console.log('App mounted')
    
    // Clear existing content
    app.innerHTML = ''
    
    // Create header with logout button
    const header = document.createElement('header')
    header.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #334155;">
        <div>
          <h1 style="margin: 0; color: #22c55e;">Flaxia</h1>
          <p style="margin: 0; opacity: 0.8;">Chronological SNS where posts are living, interactive applications</p>
        </div>
        <button id="logout-btn" style="background: none; border: 1px solid #64748b; color: #94a3b8; padding: 0.5rem 1rem; font-family: monospace; cursor: pointer; font-size: 0.875rem;">
          Sign out
        </button>
      </div>
    `
    app.appendChild(header)
    
    // Add logout functionality
    const logoutBtn = document.getElementById('logout-btn')
    if (logoutBtn) {
      logoutBtn.addEventListener('click', logout)
    }
    
    // Create Timeline
    const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxiausercontent.com'
    const timeline = createTimeline({
      sandboxOrigin
    })
    
    app.appendChild(timeline.getElement())
  }
})
