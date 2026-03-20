import { validateZipLegacy } from './zip-executor'

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
