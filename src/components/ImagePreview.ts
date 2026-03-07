import { GifPreviewProps } from '../types/post.js'

export function createImagePreview(props: GifPreviewProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'image-preview'
  
  if (!props.gifKey) {
    // Fallback for posts without image
    const fallback = document.createElement('div')
    fallback.className = 'image-preview-error'
    fallback.textContent = 'No preview available'
    container.appendChild(fallback)
    return container
  }
  
  const img = document.createElement('img')
  img.className = 'image-preview-img'
  img.alt = `Post ${props.postId} preview`
  img.loading = 'lazy'
  
  // Use the same R2 URL pattern for all image types (all stored in gif/ directory)
  const r2PublicUrl = `https://pub-${import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID || ''}.r2.dev/gif/${props.gifKey}`
  img.src = r2PublicUrl
  
  // Handle image loading errors
  img.onerror = () => {
    img.style.display = 'none'
    const fallback = document.createElement('div')
    fallback.className = 'image-preview-error'
    fallback.textContent = 'Image failed to load'
    container.appendChild(fallback)
  }
  
  container.appendChild(img)
  return container
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  return createImagePreview(props)
}
