import { Ad } from '../types/post.js'
import { executeZip } from '../lib/zip-executor.js'
import { executeFlash } from './FlashPlayer.js'

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
  adContent.appendChild(adLabel)
  
  // Create ad placeholder
  const adPlaceholder = document.createElement('div')
  adPlaceholder.className = 'ad-placeholder'
  
  // Render based on payload_type
  if (ad.payload_type === null) {
    // Body text only - render nothing inside placeholder
  } else if (ad.payload_type === 'gif' || ad.payload_type === 'image') {
    // Render image
    const img = document.createElement('img')
    img.src = `/api/ads/${ad.id}/payload`
    img.style.cssText = `
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    `
    adPlaceholder.appendChild(img)
  } else if (ad.payload_type === 'zip') {
    // Execute ZIP
    executeZip(ad.id, adPlaceholder, `/api/ads/${ad.id}/payload`)
  } else if (ad.payload_type === 'swf') {
    // Execute Flash
    executeFlash(ad.id, adPlaceholder, `/api/ads/${ad.id}/payload`)
  }
  
  adContent.appendChild(adPlaceholder)
  adBanner.appendChild(adContent)
  
  // Add impression tracking with IntersectionObserver
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        fetch(`/api/ads/${ad.id}/impression`, { method: 'POST' })
        observer.unobserve(entry.target)
      }
    })
  }, { threshold: 0.5 })
  observer.observe(adBanner)
  
  // Add click tracking
  adBanner.addEventListener('click', () => {
    if (ad.click_url) {
      fetch(`/api/ads/${ad.id}/click`, { method: 'POST' })
      window.open(ad.click_url, '_blank', 'noopener')
    }
  })
  
  return adBanner
}
