export interface PostComposerProps {
  onPostCreated?: (post: any) => void
  currentUser?: { username: string; display_name?: string; avatar_key?: string } | null
}

export class PostComposer {
  private element: HTMLElement
  private props: PostComposerProps
  private textarea!: HTMLTextAreaElement
  private fileInput!: HTMLInputElement
  private submitButton!: HTMLButtonElement
  private charCount!: HTMLSpanElement
  private selectedFile: File | null = null
  private isSubmitting = false

  constructor(props: PostComposerProps) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'post-composer'
    
    container.innerHTML = `
      <div class="composer-body">
        <div class="composer-header">
          <div class="composer-avatar"></div>
          <textarea 
            class="composer-textarea" 
            placeholder="What's happening?"
            maxlength="200"
          ></textarea>
        </div>
        <div class="composer-file-dropzone" style="display: none;">
          <div class="dropzone-content">
            <span class="dropzone-icon">📎</span>
            <span class="dropzone-text">Optional: Add an image (GIF, PNG, JPG), audio (MP3, WAV, OGG, M4A, WebM), or ZIP file</span>
          </div>
        </div>
        <div class="composer-divider"></div>
        <div class="composer-footer">
          <div class="composer-actions">
            <input type="file" class="composer-file-input" accept=".js,.wasm,.html,.gif,.png,.jpg,.jpeg,.mp3,.wav,.ogg,.m4a,.webm,.zip" />
            <button class="composer-file-button" type="button">
              📎
            </button>
            <span class="composer-char-count">0/200</span>
          </div>
          <button class="composer-submit" type="button" disabled>
            Post
          </button>
        </div>
        <div class="composer-file-preview" style="display: none;">
          <div class="file-info">
            <span class="file-name"></span>
            <button class="file-remove" type="button">✕</button>
          </div>
        </div>
      </div>
    `

    // Cache element references
    this.textarea = container.querySelector('.composer-textarea')!
    this.fileInput = container.querySelector('.composer-file-input')!
    this.submitButton = container.querySelector('.composer-submit')!
    this.charCount = container.querySelector('.composer-char-count')!

    // Set avatar
    const avatar = container.querySelector('.composer-avatar') as HTMLElement
    if (this.props.currentUser) {
      avatar.style.width = '40px'
      avatar.style.height = '40px'
      avatar.style.borderRadius = '50%'
      avatar.style.display = 'flex'
      avatar.style.alignItems = 'center'
      avatar.style.justifyContent = 'center'
      avatar.style.fontSize = '1.2rem'
      avatar.style.color = 'white'
      avatar.style.background = 'var(--accent)'
      avatar.style.flexShrink = '0'
      
      if (this.props.currentUser.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${this.props.currentUser.avatar_key})`
        avatar.style.backgroundSize = 'cover'
        avatar.style.backgroundPosition = 'center'
        avatar.textContent = ''
      } else {
        avatar.textContent = this.props.currentUser.username.charAt(0).toUpperCase()
      }
    }

    return container
  }

  private setupEventListeners(): void {
    // Textarea input handling
    this.textarea.addEventListener('input', () => {
      const length = this.textarea.value.length
      this.charCount.textContent = `${length}/200`
      if (length > 180) {
        this.charCount.style.color = length >= 200 ? 'var(--danger)' : 'var(--accent)'
      } else {
        this.charCount.style.color = 'var(--text-muted)'
      }
      this.updateSubmitButton()
    })

    // File button click
    const fileButton = this.element.querySelector('.composer-file-button')!
    fileButton.addEventListener('click', () => {
      this.fileInput.click()
    })

    // File selection
    this.fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        this.handleFileSelection(file)
      }
    })

    // File removal
    const fileRemove = this.element.querySelector('.file-remove')!
    fileRemove.addEventListener('click', () => {
      this.clearFileSelection()
    })

    // Submit button
    this.submitButton.addEventListener('click', () => {
      this.handleSubmit()
    })

    // Keyboard shortcuts
    this.textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.submitButton.disabled) {
        e.preventDefault()
        this.handleSubmit()
      }
    })
  }

  private handleFileSelection(file: File): void {
    // Check file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      alert('File size must be less than 10MB')
      this.clearFileSelection()
      return
    }

    // Check if file is an accepted format
    const allowedTypes = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm', 'application/zip']
    if (!allowedTypes.includes(file.type)) {
      alert('Only image files (GIF, PNG, JPG), audio files (MP3, WAV, OGG, M4A, WebM), and ZIP files are supported')
      this.clearFileSelection()
      return
    }

    this.selectedFile = file
    this.showFilePreview(file)
    this.updateSubmitButton()
  }

  private clearFileSelection(): void {
    this.selectedFile = null
    this.fileInput.value = ''
    this.hideFilePreview()
    this.updateSubmitButton()
  }

  private showFilePreview(file: File): void {
    const preview = this.element.querySelector('.composer-file-preview')! as HTMLElement
    const fileName = preview.querySelector('.file-name')!
    
    fileName.textContent = `${file.name} (${this.formatFileSize(file.size)})`
    preview.style.display = 'block'
  }

  private hideFilePreview(): void {
    const preview = this.element.querySelector('.composer-file-preview')! as HTMLElement
    preview.style.display = 'none'
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  private updateSubmitButton(): void {
    const hasContent = this.textarea.value.trim().length > 0
    this.submitButton.disabled = !hasContent || this.isSubmitting
    this.submitButton.textContent = this.isSubmitting ? 'Posting...' : 'Post'
  }

  private async handleSubmit(): Promise<void> {
    if (this.isSubmitting) return

    const text = this.textarea.value.trim()
    if (!text) return

    this.isSubmitting = true
    this.updateSubmitButton()

    try {
      let gifKey: string | undefined
      let zipKey: string | undefined
      let postId: string | undefined

      // Step 1: Prepare post if file is selected
      if (this.selectedFile) {
        const prepareResult = await this.preparePost(this.selectedFile)
        if (!prepareResult) {
          throw new Error('Failed to prepare post')
        }
        
        postId = prepareResult.postId
        
        if (prepareResult.zipUploadUrl && prepareResult.zipKey) {
          // ZIP file upload
          zipKey = prepareResult.zipKey
          const uploadSuccess = await this.uploadFileDirect(this.selectedFile, prepareResult.zipUploadUrl)
          if (!uploadSuccess) {
            throw new Error('Failed to upload ZIP file')
          }
        } else if (prepareResult.gifUploadUrl && prepareResult.gifKey) {
          // Image/audio file upload
          gifKey = prepareResult.gifKey
          const uploadSuccess = await this.uploadFileDirect(this.selectedFile, prepareResult.gifUploadUrl)
          if (!uploadSuccess) {
            throw new Error('Failed to upload file')
          }
        }
      }

      // Step 3: Commit post
      const commitResult = await this.commitPost(postId, gifKey, zipKey, text)
      
      if (!commitResult) {
        throw new Error('Failed to commit post')
      }

      // Clear form
      this.textarea.value = ''
      this.charCount.textContent = '0/200'
      this.clearFileSelection()

      // Notify parent
      if (this.props.onPostCreated && commitResult.post) {
        this.props.onPostCreated(commitResult.post)
      }

    } catch (error: any) {
      console.error('Failed to create post:', error)
      const errorMessage = error?.message || 'Failed to create post. Please try again.'
      alert(`${errorMessage}${error?.details ? ` (${error.details})` : ''}`)
    } finally {
      this.isSubmitting = false
      this.updateSubmitButton()
    }
  }

  private async preparePost(file: File): Promise<{ postId: string; gifUploadUrl?: string; gifKey?: string; zipUploadUrl?: string; zipKey?: string } | null> {
    try {
      const response = await fetch('/api/posts/prepare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type
        })
      })

      if (!response.ok) {
        throw new Error('Failed to prepare post')
      }

      const result = await response.json() as any
      
      // Handle both ZIP and non-ZIP responses
      if (result.zipUploadUrl && result.zipKey) {
        return {
          postId: result.postId,
          zipUploadUrl: result.zipUploadUrl,
          zipKey: result.zipKey
        }
      } else {
        return {
          postId: result.postId,
          gifUploadUrl: result.gifUploadUrl,
          gifKey: result.gifKey
        }
      }
    } catch (error) {
      console.error('Prepare post failed:', error)
      return null
    }
  }

  private async uploadFileDirect(file: File, uploadUrl: string): Promise<boolean> {
    try {
      console.log('Uploading file to:', uploadUrl, 'Type:', file.type, 'Size:', file.size)
      
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type
        },
        credentials: 'include'
      })

      console.log('Upload response status:', response.status, response.statusText)

      if (!response.ok) {
        const responseText = await response.text()
        console.error('Upload failed response:', responseText)
        
        // Try to parse as JSON, fallback to text if it fails
        let error
        try {
          error = JSON.parse(responseText)
        } catch {
          error = { error: responseText }
        }
        
        console.error('Upload failed parsed error:', error)
        return false
      }

      const responseText = await response.text()
      console.log('Upload success response:', responseText)
      
      return true
    } catch (error) {
      console.error('File upload failed:', error)
      return false
    }
  }

  private async commitPost(postId: string | undefined, gifKey: string | undefined, zipKey: string | undefined, text: string): Promise<{ post: any } | null> {
    try {
      // Extract hashtags from text
      const hashtagRegex = /#(\w+)/g
      const hashtags = Array.from(text.matchAll(hashtagRegex), (m: RegExpMatchArray) => m[1])

      const response = await fetch('/api/posts/commit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          postId: postId || crypto.randomUUID(), // Generate ID for text-only posts
          gifKey: gifKey,
          zipKey: zipKey,
          text,
          hashtags
        })
      })

      if (!response.ok) {
        const error = await response.json() as any
        throw new Error(error?.error || 'Failed to commit post')
      }

      return await response.json() as { post: any }
    } catch (error) {
      console.error('Commit post failed:', error)
      return null
    }
  }

  private async uploadFile(file: File): Promise<{ key: string } | null> {
    try {
      // Get presigned URL
      const presignResponse = await fetch('/api/upload/presigned', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          size: file.size
        })
      })

      if (!presignResponse.ok) {
        throw new Error('Failed to get upload URL')
      }

      const { uploadUrl, key } = await presignResponse.json() as { uploadUrl: string; key: string }

      // For now, we'll simulate the upload since we don't have proper presigned URLs
      // In production, this would upload to the presigned URL
      console.log('Uploading file:', file.name, 'to key:', key)
      
      // Simulate upload delay
      await new Promise(resolve => setTimeout(resolve, 1000))

      return { key }

    } catch (error) {
      console.error('File upload failed:', error)
      return null
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public focus(): void {
    this.textarea.focus()
  }

  public destroy(): void {
    this.element.remove()
  }
}

// Factory function for easier usage
export function createPostComposer(props: PostComposerProps): PostComposer {
  return new PostComposer(props)
}
