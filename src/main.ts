import { createPostCard } from './components/PostCard.js'
import type { Post } from './types/post.js'

console.log('Flaxia initialized')

// Demo data for testing
const demoPost: Post = {
  id: 'demo-post-1',
  user_id: 'user-1',
  username: 'alice',
  text: 'Check out this interactive math demo: $E = mc^2$ and $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$',
  hashtags: '["math", "physics"]',
  gif_key: 'demo-gif-1',
  payload_key: 'demo-payload-1',
  fresh_count: 42,
  created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() // 2 hours ago
}

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
    
    // Create demo PostCard
    const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'http://localhost:8080'
    const postCard = createPostCard({
      post: demoPost,
      sandboxOrigin
    })
    
    app.appendChild(postCard.getElement())
    
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
