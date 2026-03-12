import { Ad } from '../types/post.js'

export function createAdCard(ad: Ad): HTMLElement {
  const adBanner = document.createElement('div')
  adBanner.className = 'ad-banner'
  adBanner.innerHTML = `
    <div class="ad-content">
      <span class="ad-label">ADVERTISEMENT</span>
      <div class="ad-placeholder">
        <p>Ad Space</p>
      </div>
    </div>
  `
  return adBanner
}
