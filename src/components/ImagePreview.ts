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
  
  // Add loading indicator
  const loading = document.createElement('div')
  loading.className = 'image-preview-loading'
  loading.textContent = 'Loading...'
  container.appendChild(loading)
  
  const img = document.createElement('img')
  img.className = 'image-preview-img'
  img.alt = `Post ${props.postId} preview`
  img.loading = 'lazy'
  
  // Use the API proxy endpoint for images
  const imageUrl = `/api/images/${props.gifKey}`
  img.src = imageUrl
  
  // Handle image load success
  img.onload = () => {
    loading.style.display = 'none'
  }
  
  // Handle image loading errors
  img.onerror = () => {
    loading.style.display = 'none'
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
