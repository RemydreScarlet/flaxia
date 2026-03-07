import { GifPreviewProps } from '../types/post.js'

export function createAudioPlayer(props: GifPreviewProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'audio-player'
  
  if (!props.gifKey) {
    // Fallback for posts without audio
    const fallback = document.createElement('div')
    fallback.className = 'audio-player-error'
    fallback.textContent = 'No audio available'
    container.appendChild(fallback)
    return container
  }
  
  // Add loading indicator
  const loading = document.createElement('div')
  loading.className = 'audio-player-loading'
  loading.textContent = 'Loading audio...'
  container.appendChild(loading)
  
  const audio = document.createElement('audio')
  audio.className = 'audio-player-element'
  audio.controls = true
  audio.preload = 'metadata'
  
  // Use the API proxy endpoint for audio
  const audioUrl = `/api/audio/${props.gifKey}`
  audio.src = audioUrl
  
  // Handle audio load success
  audio.onloadstart = () => {
    loading.style.display = 'none'
  }
  
  // Handle audio loading errors
  audio.onerror = () => {
    loading.style.display = 'none'
    audio.style.display = 'none'
    const fallback = document.createElement('div')
    fallback.className = 'audio-player-error'
    fallback.textContent = 'Audio failed to load'
    container.appendChild(fallback)
  }
  
  container.appendChild(audio)
  return container
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  // Check if the key is for an audio file
  if (props.gifKey && props.gifKey.startsWith('audio/')) {
    return createAudioPlayer(props)
  }
  
  // For image files, use the existing ImagePreview
  // This is a simplified version - in practice, you'd import and use createImagePreview
  const container = document.createElement('div')
  container.className = 'image-preview'
  
  if (!props.gifKey) {
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
  
  const imageUrl = `/api/images/${props.gifKey}`
  img.src = imageUrl
  
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
