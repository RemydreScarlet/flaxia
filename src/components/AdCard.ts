import { Ad } from '../types/post.js'
import { executeUniversalZip, UniversalZipExecutorHandle } from '../lib/zip-manager.js'
import { executeFlash, FlashPlayerHandle } from './FlashPlayer.js'
import { adImpressionTracker } from '../lib/ad-impression-tracker.js'

// TypeScript declaration for AdSense global
declare global {
  interface Window {
    adsbygoogle: any[]
  }
}

// Global handles for cleanup
let activeZipHandle: UniversalZipExecutorHandle | null = null
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
  thumbnailUrl?: string
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
    overflow: hidden;
  `

  // Thumbnail background (if provided)
  if (props.thumbnailUrl) {
    const thumbnailBg = document.createElement('div')
    thumbnailBg.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-image: url(${props.thumbnailUrl});
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      opacity: 0.7;
      z-index: 1;
    `
    container.appendChild(thumbnailBg)
  }

  // Content overlay
  const content = document.createElement('div')
  content.style.cssText = `
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
  `

  // Icon
  const icon = document.createElement('div')
  icon.textContent = props.icon
  icon.style.cssText = `
    font-size: 48px;
    margin-bottom: 12px;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
  `

  // Text
  const text = document.createElement('div')
  text.textContent = props.label
  text.style.cssText = `
    font-size: 16px;
    font-weight: 600;
    text-align: center;
    text-shadow: 0 2px 4px rgba(0,0,0,0.3);
    background: rgba(0,0,0,0.5);
    padding: 8px 16px;
    border-radius: 20px;
    backdrop-filter: blur(4px);
  `

  content.appendChild(icon)
  content.appendChild(text)
  container.appendChild(content)

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

function mountAdmax(ad: Ad, placeholder: HTMLElement): void {
  // Set placeholder styles for admax
  placeholder.style.cssText = `
    position: relative;
    width: 100%;
    min-height: 250px;
    overflow: hidden;
    background: #f0f0f0;
    display: flex;
    align-items: center;
    justify-content: center;
  `

  // Create admax script element properly
  const script = document.createElement('script')
  script.src = 'https://adm.shinobi.jp/s/b5b3413a80d7c47326e75bfa57b8c41b'
  script.async = true
  
  placeholder.appendChild(script)
}

function mountAdSense(ad: Ad, placeholder: HTMLElement): void {
  // Set placeholder styles for AdSense
  placeholder.style.cssText = `
    position: relative;
    width: 100%;
    min-height: 250px;
    overflow: hidden;
    background: #f0f0f0;
    display: flex;
    align-items: center;
    justify-content: center;
  `

  // Create AdSense ad container
  const adContainer = document.createElement('ins')
  adContainer.className = 'adsbygoogle'
  adContainer.style.cssText = `
    display: block !important;
    width: 100%;
    min-width: 250px;
    min-height: 100px;
  `
  adContainer.setAttribute('data-ad-client', ad.adsense_client || 'ca-pub-8703789531673358')
  adContainer.setAttribute('data-ad-slot', ad.adsense_slot || '6262283560')
  adContainer.setAttribute('data-ad-format', 'auto')
  adContainer.setAttribute('data-full-width-responsive', 'true')
  
  placeholder.appendChild(adContainer)
  
  // Load AdSense ad
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({})
  } catch (error) {
    console.error('AdSense error:', error)
    // Show error message
    placeholder.innerHTML = `
      <div style="color: #666; font-size: 14px; text-align: center; padding: 20px;">
        Ad could not be loaded
      </div>
    `
  }
}

function mountAdStage(ad: Ad, placeholder: HTMLElement): void {
  // Handle AdSense ads
  if (ad.ad_type === 'adsense') {
    mountAdSense(ad, placeholder)
    return
  }

  // Handle admax ads
  if (ad.ad_type === 'admax') {
    mountAdmax(ad, placeholder)
    return
  }

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
      label: '🚀 Play',
      icon: '📦',
      thumbnailUrl: ad.thumbnail_key ? `/api/thumbnail/${ad.id}` : undefined,
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
          
          activeZipHandle = await executeUniversalZip(ad.id, placeholder, 'wvfs')
          
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
      thumbnailUrl: ad.thumbnail_key ? `/api/thumbnail/${ad.id}` : undefined,
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
  const adLabel = document.createElement('a')
  adLabel.className = 'ad-label'
  adLabel.textContent = 'Sponsored'
  adLabel.style.cssText = `
    color: inherit;
    text-decoration: none;
  `
  
  // Add hover effect
  adLabel.addEventListener('mouseenter', () => {
    adLabel.style.textDecoration = 'underline'
  })
  adLabel.addEventListener('mouseleave', () => {
    adLabel.style.textDecoration = 'none'
  })
  
  // Make label clickable if click_url is set
  if (ad.click_url) {
    adLabel.href = ad.click_url
    adLabel.target = '_blank'
    adLabel.rel = 'noopener noreferrer'
    adLabel.addEventListener('click', (e) => {
      e.stopPropagation()
      // Track click
      fetch(`/api/ads/${ad.id}/click`, { method: 'POST' }).catch(console.error)
    })
  }
  
  adContent.appendChild(adLabel)
  
  // Create ad placeholder with skeleton
  const adPlaceholder = document.createElement('div')
  adPlaceholder.className = 'ad-placeholder'
  
  // Set appropriate styling based on ad type
  if (ad.ad_type === 'admax' || ad.ad_type === 'adsense') {
    // Script-based ads use fixed height
    adPlaceholder.style.cssText = `
      position: relative;
      width: 100%;
      min-height: 250px;
      overflow: hidden;
      background: #f0f0f0;
    `
  } else {
    // Content-based ads use aspect ratio
    const aspectRatio = ad.payload_type === 'swf' ? '4 / 3' : '16 / 9'
    adPlaceholder.style.cssText = `
      position: relative;
      width: 100%;
      aspect-ratio: ${aspectRatio};
      overflow: hidden;
      background: #f0f0f0;
    `
  }
  
  // Render based on payload_type and ad_type
  if (ad.ad_type === 'adsense' || ad.ad_type === 'admax') {
    // AdSense and admax ads always use lazy loading
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          // 1. Load ad
          mountAdStage(ad, adPlaceholder)

          // 2. Track impression using batch tracker
          adImpressionTracker.trackImpression(ad.id)

          // 3. Stop observing
          observer.unobserve(entry.target)
        }
      })
    }, { threshold: 0.5 })
    observer.observe(adBanner)
  } else if (ad.payload_type === null) {
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

          // 2. Track impression using batch tracker
          adImpressionTracker.trackImpression(ad.id)

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
