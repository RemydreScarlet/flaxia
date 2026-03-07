import { PostStageProps, PostCardMode } from '../types/post.js'
import { createImagePreview } from './ImagePreview.js'
import { createSandboxFrame } from './SandboxFrame.js'

export function createPostStage(props: PostStageProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'post-stage'
  
  // Click handler to toggle between preview and execution modes
  container.addEventListener('click', () => {
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
    const imagePreview = createImagePreview({
      gifKey: props.post.gif_key,
      postId: props.post.id
    })
    container.appendChild(imagePreview)
    
    // Add click hint
    const hint = document.createElement('div')
    hint.className = 'stage-hint'
    hint.textContent = 'Click to run'
    container.appendChild(hint)
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
