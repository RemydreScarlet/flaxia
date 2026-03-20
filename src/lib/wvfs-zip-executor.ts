import { validateZipLegacy } from './zip-executor'

export interface WvfsZipExecutorHandle {
  destroy: () => void
  postId: string
}

// Global execution manager
let activeHandle: WvfsZipExecutorHandle | null = null

export async function executeWvfsZip(
  postId: string,
  containerEl: HTMLElement,
  workerUrl?: string  // custom worker URL for testing
): Promise<WvfsZipExecutorHandle> {
  // Clean up any existing execution
  if (activeHandle) {
    activeHandle.destroy()
    activeHandle = null
  }

  try {
    // Create iframe pointing to WVFS worker endpoint
    const baseUrl = workerUrl || window.location.origin
    const zipUrl = `${baseUrl}/api/wvfs-zip/${postId}`
    
    const { iframe, cleanup } = await createWvfsIframe(postId, containerEl, zipUrl)

    // Create handle with cleanup
    const handle: WvfsZipExecutorHandle = {
      postId,
      destroy: () => {
        cleanup()
        
        // Remove fullscreen button if it exists
        const fullscreenBtn = containerEl.querySelector('.wvfs-fullscreen-btn')
        if (fullscreenBtn) {
          fullscreenBtn.parentNode?.removeChild(fullscreenBtn)
        }
        
        if (activeHandle?.postId === postId) {
          activeHandle = null
        }
      }
    }

    activeHandle = handle
    return handle

  } catch (error) {
    // Clean up on error
    if (activeHandle) {
      activeHandle.destroy()
      activeHandle = null
    }
    throw error
  }
}

async function createWvfsIframe(
  postId: string, 
  containerEl: HTMLElement, 
  zipUrl: string
): Promise<{ iframe: HTMLIFrameElement, cleanup: () => void }> {
  // Create iframe container
  const iframeContainer = document.createElement('div')
  iframeContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
  `
  
  // Create iframe pointing to WVFS worker endpoint
  const iframe = document.createElement('iframe')
  iframe.src = zipUrl
  iframe.sandbox = 'allow-scripts allow-pointer-lock allow-fullscreen'
  iframe.setAttribute('allow', 'fullscreen')
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  `
  
  // Add fullscreen button
  const fullscreenBtn = document.createElement('button')
  fullscreenBtn.textContent = '⛶ Fullscreen'
  fullscreenBtn.className = 'wvfs-fullscreen-btn'
  fullscreenBtn.style.cssText = `
    margin-top: 8px;
    padding: 4px 8px;
    font-size: 12px;
    border: 1px solid #ccc;
    background: #f0f0f0;
    cursor: pointer;
    border-radius: 4px;
    align-self: center;
  `
  fullscreenBtn.onclick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    
    try {
      if (iframeContainer.requestFullscreen) {
        iframeContainer.requestFullscreen().catch(err => {
          console.warn('Container fullscreen failed:', err)
          if (iframe.requestFullscreen) {
            iframe.requestFullscreen().catch(err2 => {
              console.warn('Iframe fullscreen failed:', err2)
            })
          }
        })
      } else if (iframe.requestFullscreen) {
        iframe.requestFullscreen().catch(err => {
          console.warn('Iframe fullscreen failed:', err)
        })
      }
    } catch (error) {
      console.error('Fullscreen error:', error)
    }
  }
  
  // Clear container and add iframe container
  containerEl.innerHTML = ''
  containerEl.appendChild(iframeContainer)
  iframeContainer.appendChild(iframe)
  iframeContainer.appendChild(fullscreenBtn)
  
  const cleanup = () => {
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe)
    }
  }
  
  return { iframe, cleanup }
}

// Server-side WVFS functions (to be used in Workers)
export async function extractZipToWvfs(zipData: ArrayBuffer, postId: string): Promise<void> {
  // This function runs in the Worker with node:fs access
  const fs = await import('node:fs')
  const path = await import('node:path')
  
  // Create temporary directory for this post
  const extractDir = `/tmp/wvfs-zip-${postId}`
  
  try {
    // Clean up any existing directory
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
    
    // Create directory
    fs.mkdirSync(extractDir, { recursive: true })
    
    // Extract ZIP using fflate (server-compatible)
    const fflate = await import('fflate')
    const zip = fflate.unzipSync(new Uint8Array(zipData))
    
    // Validate ZIP structure
    await validateZipLegacy(zipData)
    
    // Write files to WVFS
    for (const [filename, fileData] of Object.entries(zip)) {
      if (filename.endsWith('/')) continue // skip directories
      
      const filePath = path.join(extractDir, filename)
      const fileDir = path.dirname(filePath)
      
      // Create directory if needed
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true })
      }
      
      // Write file
      fs.writeFileSync(filePath, fileData)
    }
    
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
    throw error
  }
}

export async function serveFileFromWvfs(postId: string, filePath: string): Promise<Response | null> {
  // This function runs in the Worker to serve files
  const fs = await import('node:fs')
  const path = await import('node:path')
  
  const extractDir = `/tmp/wvfs-zip-${postId}`
  const fullPath = path.join(extractDir, filePath)
  
  // Security: ensure path is within extractDir
  if (!fullPath.startsWith(extractDir)) {
    return null
  }
  
  try {
    if (!fs.existsSync(fullPath)) {
      return null
    }
    
    const fileData = fs.readFileSync(fullPath)
    const ext = path.extname(filePath).toLowerCase()
    
    // Determine content type
    let contentType = 'text/plain'
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.wasm': 'application/wasm',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.json': 'application/json',
      '.txt': 'text/plain'
    }
    
    contentType = mimeTypes[ext] || 'text/plain'
    
    return new Response(fileData, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error) {
    console.error('Error serving file from WVFS:', error)
    return null
  }
}

export async function cleanupWvfsZip(postId: string): Promise<void> {
  // Clean up WVFS directory for this post
  const fs = await import('node:fs')
  const extractDir = `/tmp/wvfs-zip-${postId}`
  
  try {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
  } catch (error) {
    console.error('Error cleaning up WVFS:', error)
  }
}
