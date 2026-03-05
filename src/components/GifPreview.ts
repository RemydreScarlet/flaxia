import { GifPreviewProps } from '../types/post.js'

export function createGifPreview(props: GifPreviewProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'gif-preview'
  
  if (!props.gifKey) {
    // Fallback for posts without GIF
    const fallback = document.createElement('div')
    fallback.className = 'gif-fallback'
    fallback.textContent = 'No preview available'
    container.appendChild(fallback)
    return container
  }
  
  const img = document.createElement('img')
  img.className = 'gif-image'
  img.alt = `Post ${props.postId} preview`
  img.loading = 'lazy'
  
  // Construct R2 public URL - use import.meta.env for Vite
  const r2PublicUrl = `https://pub-${import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID || ''}.r2.dev/gif/${props.gifKey}`
  img.src = r2PublicUrl
  
  // Handle image loading errors
  img.onerror = () => {
    img.style.display = 'none'
    const fallback = document.createElement('div')
    fallback.className = 'gif-fallback'
    fallback.textContent = 'Preview unavailable'
    container.appendChild(fallback)
  }
  
  container.appendChild(img)
  return container
}
