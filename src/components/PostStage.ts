import { PostStageProps, PostCardMode } from '../types/post.js'
import { createImagePreview } from './ImagePreview.js'
import { createAudioPlayer } from './AudioPlayer.js'
import { createSandboxFrame } from './SandboxFrame.js'

// Load JSZip dynamically
declare const JSZip: any

async function loadJSZip(): Promise<any> {
  if (typeof window !== 'undefined' && (window as any).JSZip) {
    return (window as any).JSZip
  }
  
  // Load JSZip from CDN if not available
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
    script.onload = () => resolve((window as any).JSZip)
    script.onerror = reject
    document.head.appendChild(script)
  })
}

async function validateZipContainsIndexHtml(zipBlob: Blob): Promise<boolean> {
  try {
    const JSZip = await loadJSZip()
    const zip = await JSZip.loadAsync(zipBlob)
    
    // Check if index.html exists in the ZIP
    const hasIndexHtml = zip.file('index.html') !== null || 
                       zip.file('index.htm') !== null ||
                       zip.files['index.html'] !== null ||
                       zip.files['index.htm'] !== null
    
    return hasIndexHtml
  } catch (error) {
    console.error('Error validating ZIP:', error)
    return false
  }
}

interface ZipExecutionButtonProps {
  postId: string
  onClick: () => void
}

function createZipExecutionButton(props: ZipExecutionButtonProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'zip-execution-button'
  container.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 200px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: white;
    font-weight: 600;
    font-size: 16px;
    gap: 8px;
  `

  const icon = document.createElement('span')
  icon.textContent = '🚀'
  icon.style.fontSize = '24px'

  const text = document.createElement('span')
  text.textContent = 'Click to Execute ZIP'

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
  container.addEventListener('click', async (e) => {
    e.stopPropagation()
    
    // Show loading state
    const originalContent = container.innerHTML
    container.innerHTML = '<span style="font-size: 20px;">⏳</span><span>Loading...</span>'
    container.style.pointerEvents = 'none'

    try {
      // Fetch ZIP file
      const response = await fetch(`/api/zip/${props.postId}`)
      if (!response.ok) {
        throw new Error('Failed to fetch ZIP file')
      }

      // Get ZIP blob
      const zipBlob = await response.blob()
      
      // Validate ZIP contains index.html
      const hasIndexHtml = await validateZipContainsIndexHtml(zipBlob)
      if (!hasIndexHtml) {
        throw new Error('ZIP file must contain index.html')
      }
      
      // For now, just log that we would execute the ZIP
      // The actual execution engine will be implemented separately
      console.log('execute', props.postId, zipBlob)
      
      // Trigger the mode change to show sandbox
      props.onClick()
      
    } catch (error) {
      console.error('Failed to load ZIP:', error)
      container.innerHTML = originalContent
      container.style.pointerEvents = 'auto'
      alert('Failed to load ZIP file. Please try again.')
    }
  })

  return container
}

export function createPostStage(props: PostStageProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'post-stage'
  
  // Click handler to toggle between preview and execution modes
  // Only for non-ZIP files - ZIP files have their own button
  container.addEventListener('click', (e) => {
    // Don't toggle mode if clicking on ZIP execution button
    if ((e.target as HTMLElement).closest('.zip-execution-button')) {
      return
    }
    
    const newMode = props.mode === PostCardMode.PREVIEW 
      ? PostCardMode.EXECUTING 
      : PostCardMode.PREVIEW
    props.onModeChange(newMode)
  })
  
  // Render current mode
  updateStageContent(container, props)
  
  return container
}

function updateStageContent(container: HTMLElement, props: PostStageProps): void {
  // Clear existing content
  container.innerHTML = ''
  
  // Only show content if there are attachments
  if (!props.post.gif_key && !props.post.payload_key) {
    return
  }
  
  if (props.mode === PostCardMode.PREVIEW) {
    let mediaElement
    
    // Check if it's a ZIP file (payload_key starting with 'zip/')
    if (props.post.payload_key && props.post.payload_key.startsWith('zip/')) {
      // Create ZIP execution button
      mediaElement = createZipExecutionButton({
        postId: props.post.id,
        onClick: () => props.onModeChange(PostCardMode.EXECUTING)
      })
    } else if (props.post.gif_key && props.post.gif_key.startsWith('audio/')) {
      mediaElement = createAudioPlayer({
        gifKey: props.post.gif_key,
        postId: props.post.id
      })
    } else {
      mediaElement = createImagePreview({
        gifKey: props.post.gif_key,
        postId: props.post.id
      })
    }
    
    container.appendChild(mediaElement)
    
    // Add click hint for non-ZIP files
    if (!props.post.payload_key?.startsWith('zip/')) {
      const hint = document.createElement('div')
      hint.className = 'stage-hint'
      hint.textContent = 'Click to run'
      container.appendChild(hint)
    }
  } else {
    const sandboxFrame = createSandboxFrame({
      postId: props.post.id,
      sandboxOrigin: props.sandboxOrigin
    })
    container.appendChild(sandboxFrame)
  }
}

// Export a function to update the stage content when mode changes
export function updatePostStage(container: HTMLElement, props: PostStageProps): void {
  updateStageContent(container, props)
}
