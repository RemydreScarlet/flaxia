import { Ad } from '../types/post.js'
import { executeZip, ZipExecutorHandle } from '../lib/zip-executor.js'
import { executeFlash, FlashPlayerHandle } from './FlashPlayer.js'

// Global handles for cleanup
let activeZipHandle: ZipExecutorHandle | null = null
let activeFlashHandle: FlashPlayerHandle | null = null

// Cleanup handles on page unload
window.addEventListener('beforeunload', () => {
  if (activeZipHandle) {
    activeZipHandle.destroy()
    activeZipHandle = null
  }
  if (activeFlashHandle) {
    activeFlashHandle.destroy()
    activeFlashHandle = null
  }
})

function createExecutionButton(props: {
  postId: string
  label: string
  icon: string
  onClick: () => void
}): HTMLElement {
  const container = document.createElement('div')
  container.className = 'zip-execution-button'
  container.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: white;
  `

  // Icon
  const icon = document.createElement('div')
  icon.textContent = props.icon
  icon.style.cssText = `
    font-size: 48px;
    margin-bottom: 12px;
  `

  // Text
  const text = document.createElement('div')
  text.textContent = props.label
  text.style.cssText = `
    font-size: 16px;
    font-weight: 600;
    text-align: center;
  `

  container.appendChild(icon)
  container.appendChild(text)

  // Hover effects
  container.addEventListener('mouseenter', () => {
    container.style.transform = 'scale(1.02)'
    container.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)'
  })

  container.addEventListener('mouseleave', () => {
    container.style.transform = 'scale(1)'
    container.style.boxShadow = 'none'
  })

  // Click handler
  container.addEventListener('click', async () => {
    props.onClick()
  })

  return container
}

function handleDirectClick(ad: Ad): void {
  if (!ad.click_url) return
  fetch(`/api/ads/${ad.id}/click`, { method: 'POST' })
  window.open(ad.click_url, '_blank', 'noopener')
}

function mountAdStage(ad: Ad, placeholder: HTMLElement): void {
  // Update placeholder styles for content
  const aspectRatio = ad.payload_type === 'swf' ? '4 / 3' : '16 / 9'
  placeholder.style.cssText = `
    position: relative;
    width: 100%;
    aspect-ratio: ${aspectRatio};
    overflow: hidden;
    background: #000;
  `

  // Render based on payload_type
  if (ad.payload_type === null) {
    // Body text only - no stage rendered
  } else if (ad.payload_type === 'gif' || ad.payload_type === 'image') {
    // Render image
    const img = document.createElement('img')
    img.src = `/api/ads/${ad.id}/payload`
    img.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
    `
    placeholder.appendChild(img)
  } else if (ad.payload_type === 'zip') {
    // Show click-to-run button
    const runButton = createExecutionButton({
      postId: ad.id,
      label: '🚀 Click to Run',
      icon: '📦',
      onClick: async () => {
        // Show loading state
        const originalContent = placeholder.innerHTML
        placeholder.innerHTML = '<span style="font-size: 20px;">⏳</span><span>Loading...</span>'
        placeholder.style.pointerEvents = 'none'

        try {
          // Record play start for games
          fetch(`/api/ads/${ad.id}/play`, { method: 'POST' }).catch(console.error)
          
          // Clean up any existing handle
          if (activeZipHandle) {
            activeZipHandle.destroy()
            activeZipHandle = null
          }
          
          activeZipHandle = await executeZip(ad.id, placeholder, `/api/ads/${ad.id}/payload`)
          
          // Set pointer events for iframe interaction
          const adBanner = placeholder.closest('.ad-banner') as HTMLElement
          if (adBanner) {
            adBanner.style.pointerEvents = 'none'
            placeholder.style.pointerEvents = 'auto'
          }
          
          // After execution starts, show Visit button if click_url exists
          if (ad.click_url) {
            const visitBtn = document.createElement('button')
            visitBtn.textContent = `Visit → ${ad.click_url}`
            visitBtn.style.cssText = `
              background: #22c55e;
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              margin-top: 12px;
            `
            
            visitBtn.addEventListener('click', (e) => {
              e.stopPropagation()
              handleDirectClick(ad)
            })
            
            placeholder.appendChild(visitBtn)
          }
        } catch (error) {
          console.error('Failed to load ZIP:', error)
          placeholder.innerHTML = originalContent
          placeholder.style.pointerEvents = 'auto'
          alert('Failed to load ZIP content. Please try again.')
        }
      }
    })
    
    placeholder.appendChild(runButton)
  } else if (ad.payload_type === 'swf') {
    // Show click-to-play button
    const playButton = createExecutionButton({
      postId: ad.id,
      label: '⚡ Click to Play',
      icon: '🎮',
      onClick: async () => {
        // Show loading state
        const originalContent = placeholder.innerHTML
        placeholder.innerHTML = '<span style="font-size: 20px;">⏳</span><span>Loading...</span>'
        placeholder.style.pointerEvents = 'none'

        try {
          // Record play start for games
          fetch(`/api/ads/${ad.id}/play`, { method: 'POST' }).catch(console.error)
          
          // Clean up any existing handle
          if (activeFlashHandle) {
            activeFlashHandle.destroy()
            activeFlashHandle = null
          }
          
          activeFlashHandle = await executeFlash(ad.id, placeholder, `/api/ads/${ad.id}/payload`)
          
          // Set pointer events for iframe interaction
          const adBanner = placeholder.closest('.ad-banner') as HTMLElement
          if (adBanner) {
            adBanner.style.pointerEvents = 'none'
            placeholder.style.pointerEvents = 'auto'
          }
          
          // After execution starts, show Visit button if click_url exists
          if (ad.click_url) {
            const visitBtn = document.createElement('button')
            visitBtn.textContent = `Visit → ${ad.click_url}`
            visitBtn.style.cssText = `
              background: #22c55e;
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              margin-top: 12px;
            `
            
            visitBtn.addEventListener('click', (e) => {
              e.stopPropagation()
              handleDirectClick(ad)
            })
            
            placeholder.appendChild(visitBtn)
          }
        } catch (error) {
          console.error('Failed to load SWF:', error)
          placeholder.innerHTML = originalContent
          placeholder.style.pointerEvents = 'auto'
          alert('Failed to load Flash content. Please try again.')
        }
      }
    })
    
    placeholder.appendChild(playButton)
  }
}

export function createAdCard(ad: Ad): HTMLElement {
  const adBanner = document.createElement('div')
  adBanner.className = 'ad-banner'
  
  // Create ad content container
  const adContent = document.createElement('div')
  adContent.className = 'ad-content'
  
  // Create ad label
  const adLabel = document.createElement('span')
  adLabel.className = 'ad-label'
  adLabel.textContent = 'Sponsored'
  
  // Make label clickable if click_url is set
  if (ad.click_url) {
    adLabel.style.cursor = 'pointer'
    adLabel.style.textDecoration = 'underline'
    adLabel.addEventListener('click', (e) => {
      e.stopPropagation()
      handleDirectClick(ad)
    })
  }
  
  adContent.appendChild(adLabel)
  
  // Create ad placeholder with skeleton
  const adPlaceholder = document.createElement('div')
  adPlaceholder.className = 'ad-placeholder'
  const aspectRatio = ad.payload_type === 'swf' ? '4 / 3' : '16 / 9'
  adPlaceholder.style.cssText = `
    position: relative;
    width: 100%;
    aspect-ratio: ${aspectRatio};
    overflow: hidden;
    background: #f0f0f0;
  `
  
  // Render based on payload_type
  if (ad.payload_type === null) {
    // Body text only - no stage, no Visit button if click_url is null
    // Entire card clickable if click_url exists
    if (ad.click_url) {
      adBanner.addEventListener('click', () => handleDirectClick(ad))
    }
  } else {
    // For all other payload types, use lazy loading with IntersectionObserver
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          // 1. Load stage content (lazy)
          mountAdStage(ad, adPlaceholder)

          // 2. Track impression
          fetch(`/api/ads/${ad.id}/impression`, { method: 'POST' })

          // 3. Stop observing
          observer.unobserve(entry.target)
        }
      })
    }, { threshold: 0.5 })
    observer.observe(adBanner)
  }
  
  adContent.appendChild(adPlaceholder)
  adBanner.appendChild(adContent)
  
  return adBanner
}
