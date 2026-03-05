import { PostTextProps } from '../types/post.js'

export function createPostText(props: PostTextProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'post-text'
  
  // Split text by math delimiters and process
  const parts = parseMathInText(props.text)
  
  parts.forEach(part => {
    if (part.type === 'text') {
      const textNode = document.createTextNode(part.content)
      container.appendChild(textNode)
    } else if (part.type === 'math') {
      const mathElement = createMathElement(part.content)
      container.appendChild(mathElement)
    }
  })
  
  return container
}

interface TextPart {
  type: 'text' | 'math'
  content: string
}

function parseMathInText(text: string): TextPart[] {
  const parts: TextPart[] = []
  const mathRegex = /\$\$([^$]+)\$\$|\$([^$]+)\$/g
  let lastIndex = 0
  let match
  
  while ((match = mathRegex.exec(text)) !== null) {
    // Add text before math
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: text.slice(lastIndex, match.index)
      })
    }
    
    // Add math content
    const mathContent = match[1] || match[2] // $$...$ or $...$
    parts.push({
      type: 'math',
      content: mathContent.trim()
    })
    
    lastIndex = mathRegex.lastIndex
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      content: text.slice(lastIndex)
    })
  }
  
  return parts
}

function createMathElement(mathContent: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'math-inline'
  span.textContent = mathContent
  
  // Load KaTeX if not already loaded
  if (!window.katex) {
    loadKaTeX().then(() => renderMath(span, mathContent))
  } else {
    renderMath(span, mathContent)
  }
  
  return span
}

function loadKaTeX(): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.0/dist/katex.min.css'
    document.head.appendChild(link)
    
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.0/dist/katex.min.js'
    script.onload = () => resolve()
    script.onerror = reject
    document.head.appendChild(script)
  })
}

function renderMath(element: HTMLElement, mathContent: string): void {
  if (window.katex) {
    try {
      window.katex.render(mathContent, element, {
        throwOnError: false,
        displayMode: false
      })
    } catch (error) {
      element.textContent = mathContent
    }
  }
}

declare global {
  interface Window {
    katex?: any
  }
}
