import JSZip from 'jszip'

export interface ZipExecutorHandle {
  destroy: () => void
}

// Allowed extensions and their MIME types
const ALLOWED_EXTENSIONS: Record<string, string> = {
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
  '.txt': 'text/plain',
  '.glsl': 'text/plain',
  '.wgsl': 'text/plain'
}

// Global execution manager
let activeHandle: ZipExecutorHandle | null = null

export async function executeZip(
  postId: string,
  containerEl: HTMLElement
): Promise<ZipExecutorHandle> {
  // Clean up any existing execution
  if (activeHandle) {
    activeHandle.destroy()
    activeHandle = null
  }

  try {
    // Step 1: Fetch ZIP
    const response = await fetch(`/api/zip/${postId}`)
    if (!response.ok) {
      throw new Error('ZIP download failed')
    }
    
    const zipData = await response.arrayBuffer()
    const zip = await JSZip.loadAsync(zipData)

    // Step 2: Validate ZIP
    validateZip(zip)

    // Step 3: Generate Blob URL Map
    const blobUrlMap = await generateBlobUrlMap(zip)

    // Step 4: Rewrite index.html
    const rewrittenHtml = await rewriteIndexHtml(zip, blobUrlMap)

    // Step 5: Create iframe
    const { iframe, htmlBlobUrl } = createIframe(rewrittenHtml, containerEl)

    // Step 6: Create handle with cleanup
    const handle: ZipExecutorHandle = {
      destroy: () => {
        // Remove iframe from DOM
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe)
        }
        
        // Remove fullscreen button if it exists
        const fullscreenBtn = containerEl.querySelector('.zip-fullscreen-btn')
        if (fullscreenBtn) {
          fullscreenBtn.parentNode?.removeChild(fullscreenBtn)
        }
        
        // Revoke all blob URLs
        blobUrlMap.forEach(url => URL.revokeObjectURL(url))
        URL.revokeObjectURL(htmlBlobUrl)
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

function validateZip(zip: JSZip): void {
  const files = Object.entries(zip.files)
  
  // File count: 255 or fewer
  if (files.length > 255) {
    throw new Error('Too many files (max 255)')
  }

  let totalSize = 0
  let hasIndexHtml = false

  for (const [path, file] of files) {
    // Skip directories
    if (file.dir) continue

    // Path length: 255 characters or fewer
    if (path.length > 255) {
      throw new Error(`Path too long: ${path}`)
    }

    // Directory depth: 10 levels or fewer
    const depth = (path.match(/\//g) || []).length
    if (depth > 10) {
      throw new Error(`Directory too deep: ${path}`)
    }

    // Total extracted size: 100MB or less
    const fileSize = (file as any)._data?.uncompressedSize || 0
    totalSize += fileSize
    if (totalSize > 100 * 1024 * 1024) {
      throw new Error('Extracted size too large (max 100MB)')
    }

    // Nested ZIP files: forbidden
    if (path.toLowerCase().endsWith('.zip')) {
      throw new Error('Nested ZIP files are not allowed')
    }

    // Symbolic links: forbidden
    const unixPermissions = (file as any).unixPermissions
    if (unixPermissions && (unixPermissions & 0xF000) === 0xA000) {
      throw new Error('Symbolic links are not allowed')
    }

    // Path traversal: forbidden
    if (path.includes('../')) {
      throw new Error(`Path traversal detected: ${path}`)
    }

    // Absolute paths: forbidden
    if (path.startsWith('/')) {
      throw new Error(`Absolute paths are not allowed: ${path}`)
    }

    // Check for index.html at root
    if (path === 'index.html') {
      hasIndexHtml = true
    }

    // File extensions: only allowed extensions permitted
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
    if (!ALLOWED_EXTENSIONS[ext]) {
      throw new Error(`File type not allowed: ${path}`)
    }
  }

  // index.html: must exist at root level
  if (!hasIndexHtml) {
    throw new Error('index.html not found at root')
  }
}

async function generateBlobUrlMap(zip: JSZip): Promise<Map<string, string>> {
  const blobUrlMap = new Map<string, string>()

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue

    // Normalize path: strip leading "./"
    const normalizedPath = path.replace(/^\.\//, '')
    
    // Get MIME type from allowed extensions
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
    const mimeType = ALLOWED_EXTENSIONS[ext]
    
    if (mimeType) {
      const content = await file.async('uint8array')
      const arrayBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer
      const blob = new Blob([arrayBuffer], { type: mimeType })
      const blobUrl = URL.createObjectURL(blob)
      blobUrlMap.set(normalizedPath, blobUrl)
    }
  }

  return blobUrlMap
}

async function rewriteIndexHtml(zip: JSZip, blobUrlMap: Map<string, string>): Promise<string> {
  const indexFile = zip.files['index.html']
  if (!indexFile || indexFile.dir) {
    throw new Error('index.html not found at root')
  }

  const htmlContent = await indexFile.async('string')
  
  // Parse HTML with DOMParser
  const parser = new DOMParser()
  const doc = parser.parseFromString(htmlContent, 'text/html')
  
  // Rewrite HTML attributes
  rewriteAttributes(doc, blobUrlMap)
  
  // Rewrite CSS in style tags and inline styles
  rewriteCss(doc, blobUrlMap)
  
  // Serialize back to string
  return new XMLSerializer().serializeToString(doc)
}

function rewriteAttributes(doc: Document, blobUrlMap: Map<string, string>): void {
  const elements = doc.querySelectorAll('*')
  
  elements.forEach(element => {
    // Rewrite src attributes
    const src = element.getAttribute('src')
    if (src && shouldRewritePath(src)) {
      const normalizedPath = src.replace(/^\.\//, '')
      const blobUrl = blobUrlMap.get(normalizedPath)
      if (blobUrl) {
        element.setAttribute('src', blobUrl)
      }
    }
    
    // Rewrite href attributes
    const href = element.getAttribute('href')
    if (href && shouldRewritePath(href)) {
      const normalizedPath = href.replace(/^\.\//, '')
      const blobUrl = blobUrlMap.get(normalizedPath)
      if (blobUrl) {
        element.setAttribute('href', blobUrl)
      }
    }
  })
}

function rewriteCss(doc: Document, blobUrlMap: Map<string, string>): void {
  // Rewrite CSS in style tags
  const styleTags = doc.querySelectorAll('style')
  styleTags.forEach(styleTag => {
    if (styleTag.textContent) {
      styleTag.textContent = rewriteCssUrls(styleTag.textContent, blobUrlMap)
    }
  })
  
  // Rewrite inline style attributes
  const elements = doc.querySelectorAll('[style]')
  elements.forEach(element => {
    const style = element.getAttribute('style')
    if (style) {
      element.setAttribute('style', rewriteCssUrls(style, blobUrlMap))
    }
  })
}

function rewriteCssUrls(cssText: string, blobUrlMap: Map<string, string>): string {
  // Rewrite url() references in CSS
  return cssText.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, path) => {
    if (shouldRewritePath(path)) {
      const normalizedPath = path.replace(/^\.\//, '')
      const blobUrl = blobUrlMap.get(normalizedPath)
      if (blobUrl) {
        return `url("${blobUrl}")`
      }
    }
    return match
  })
}

function shouldRewritePath(path: string): boolean {
  // Don't rewrite URLs that are already absolute, data URLs, or blob URLs
  return !path.startsWith('https://') && 
         !path.startsWith('http://') && 
         !path.startsWith('data:') && 
         !path.startsWith('blob:')
}

function createIframe(rewrittenHtml: string, containerEl: HTMLElement): { iframe: HTMLIFrameElement, htmlBlobUrl: string } {
  // Create blob URL for HTML
  const htmlBlob = new Blob([rewrittenHtml], { type: 'text/html' })
  const htmlBlobUrl = URL.createObjectURL(htmlBlob)
  
  // Create iframe container
  const iframeContainer = document.createElement('div')
  iframeContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  `
  
  // Create iframe
  const iframe = document.createElement('iframe')
  iframe.src = htmlBlobUrl
  iframe.sandbox = 'allow-scripts allow-pointer-lock'
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
  fullscreenBtn.className = 'zip-fullscreen-btn'
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
  fullscreenBtn.onclick = () => {
    if (iframe.requestFullscreen) {
      iframe.requestFullscreen()
    }
  }
  
  // Clear container and add iframe container
  containerEl.innerHTML = ''
  containerEl.appendChild(iframeContainer)
  iframeContainer.appendChild(iframe)
  iframeContainer.appendChild(fullscreenBtn)
  
  return { iframe, htmlBlobUrl }
}
