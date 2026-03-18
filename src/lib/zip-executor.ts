
export interface ZipExecutorHandle {
  destroy: () => void
}

// Global execution manager
let activeHandle: ZipExecutorHandle | null = null

// Cache for dynamic imports
let jszipPromise: Promise<any> | null = null

async function getJSZip() {
  if (!jszipPromise) {
    jszipPromise = import('jszip')
  }
  const JSZipModule = await jszipPromise
  return (JSZipModule as any).default
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

export async function executeZip(
  postId: string,
  containerEl: HTMLElement,
  url?: string  // if provided, fetch from this URL instead of /api/zip/${postId}
): Promise<ZipExecutorHandle> {
  // Clean up any existing execution
  if (activeHandle) {
    activeHandle.destroy()
    activeHandle = null
  }

  try {
    // Step 1: Fetch ZIP
    const response = await fetch(url || `/api/zip/${postId}`)
    if (!response.ok) {
      throw new Error('ZIP download failed')
    }
    
    const zipData = await response.arrayBuffer()
    const JSZip = await getJSZip()
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

function validateZip(zip: any): void {
  const files = Object.entries(zip.files)
  
  // File count: 255 or fewer
  if (files.length > 255) {
    throw new Error('Too many files (max 255)')
  }

  let totalSize = 0
  let hasIndexHtml = false

  for (const [path, file] of files) {
    // Skip directories
    if ((file as any).dir) continue

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

async function generateBlobUrlMap(zip: any): Promise<Map<string, string>> {
  const blobUrlMap = new Map<string, string>()

  for (const [path, file] of Object.entries(zip.files)) {
    if ((file as any).dir) continue

    // Normalize path: strip leading "./"
    const normalizedPath = path.replace(/^\.\//, '')
    
    // Get MIME type from allowed extensions
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
    const mimeType = ALLOWED_EXTENSIONS[ext]
    
    if (mimeType) {
      const content = await (file as any).async('uint8array')
      const arrayBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer
      const blob = new Blob([arrayBuffer], { type: mimeType })
      const blobUrl = URL.createObjectURL(blob)
      blobUrlMap.set(normalizedPath, blobUrl)
    }
  }

  return blobUrlMap
}

async function rewriteIndexHtml(zip: any, blobUrlMap: Map<string, string>): Promise<string> {
  const indexFile = zip.files['index.html']
  if (!indexFile || indexFile.dir) {
    throw new Error('index.html not found at root')
  }

  let htmlContent = await (indexFile as any).async('string')
  
  // Use string replacement to avoid corrupting JavaScript code
  htmlContent = rewriteHtmlString(htmlContent, blobUrlMap)
  
  return htmlContent
}

function rewriteHtmlString(htmlContent: string, blobUrlMap: Map<string, string>): string {
  // Rewrite src attributes in HTML tags (excluding script tags to preserve JS)
  htmlContent = htmlContent.replace(/<(?!script)([^>]+)\s+src\s*=\s*['"]([^'"]+)['"]/gi, (match, tagAttrs, src) => {
    if (shouldRewritePath(src)) {
      const normalizedPath = src.replace(/^\.\//, '')
      const blobUrl = blobUrlMap.get(normalizedPath)
      if (blobUrl) {
        return `<${tagAttrs} src="${blobUrl}"`
      }
    }
    return match
  })
  
  // Rewrite href attributes in HTML tags
  htmlContent = htmlContent.replace(/<([^>]+)\s+href\s*=\s*['"]([^'"]+)['"]/gi, (match, tagAttrs, href) => {
    if (shouldRewritePath(href)) {
      const normalizedPath = href.replace(/^\.\//, '')
      const blobUrl = blobUrlMap.get(normalizedPath)
      if (blobUrl) {
        return `<${tagAttrs} href="${blobUrl}"`
      }
    }
    return match
  })
  
  // Rewrite CSS in style tags
  htmlContent = htmlContent.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, cssContent) => {
    const rewrittenCss = rewriteCssUrls(cssContent, blobUrlMap)
    return match.replace(cssContent, rewrittenCss)
  })
  
  // Rewrite inline style attributes
  htmlContent = htmlContent.replace(/style\s*=\s*['"]([^'"]+)['"]/gi, (match, styleContent) => {
    const rewrittenStyle = rewriteCssUrls(styleContent, blobUrlMap)
    return `style="${rewrittenStyle}"`
  })
  
  return htmlContent
}


function rewriteCssUrls(cssText: string, blobUrlMap: Map<string, string>): string {
  // Rewrite url() references in CSS - be more precise to avoid JS interference
  return cssText.replace(/url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, (match, path) => {
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
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
  `
  
  // Create iframe
  const iframe = document.createElement('iframe')
  iframe.src = htmlBlobUrl
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
  fullscreenBtn.onclick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    
    // Try fullscreen immediately on user interaction
    try {
      if (iframeContainer.requestFullscreen) {
        iframeContainer.requestFullscreen().catch(err => {
          console.warn('Container fullscreen failed:', err)
          // Fallback to iframe
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
  
  return { iframe, htmlBlobUrl }
}
