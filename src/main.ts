import { createTimeline } from './components/Timeline.js'

console.log('Flaxia initialized')

// Basic app initialization
document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app')
  if (app) {
    console.log('App mounted')
    
    // Clear existing content
    app.innerHTML = ''
    
    // Create header
    const header = document.createElement('header')
    header.innerHTML = `
      <h1>Flaxia</h1>
      <p>Chronological SNS where posts are living, interactive applications</p>
    `
    app.appendChild(header)
    
    // Create Timeline
    const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxiausercontent.com'
    const timeline = createTimeline({
      sandboxOrigin
    })
    
    app.appendChild(timeline.getElement())
    
    // Add some spacing
    const style = document.createElement('style')
    style.textContent = `
      header {
        margin-bottom: 2rem;
        padding-bottom: 1rem;
        border-bottom: 1px solid #334155;
      }
    `
    document.head.appendChild(style)
  }
})
