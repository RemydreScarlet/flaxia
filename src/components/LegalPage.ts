interface LegalPageProps {
  type: 'terms' | 'privacy'
}

export function createLegalPage({ type }: LegalPageProps) {
  // Create main container
  const container = document.createElement('div')
  container.className = 'legal-page'

  // Create content wrapper
  const contentWrapper = document.createElement('div')
  contentWrapper.className = 'legal-content-wrapper'

  // Header with wordmark only
  const header = document.createElement('header')
  header.className = 'legal-header'

  const wordmark = document.createElement('a')
  wordmark.href = '/'
  wordmark.className = 'legal-wordmark'
  wordmark.textContent = '🌿 Flaxia'
  wordmark.addEventListener('click', (e) => {
    e.preventDefault()
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  header.appendChild(wordmark)

  // Content container
  const content = document.createElement('article')
  content.className = 'legal-content'

  // Load and render markdown
  const loadContent = async () => {
    const fileName = type === 'terms' ? 'terms.md' : 'privacy.md'
    const title = type === 'terms' ? 'Terms of Service' : 'Privacy Policy'

    try {
      const response = await fetch(`/legal/${fileName}`)
      if (!response.ok) {
        throw new Error('Failed to load content')
      }

      const markdown = await response.text()

      // Parse effective date from markdown (first line starting with "Effective Date:")
      const effectiveDateMatch = markdown.match(/^Effective Date:\s*(.+)$/m)
      const effectiveDate = effectiveDateMatch ? effectiveDateMatch[1] : null

      // Remove the effective date line from content for rendering
      const contentMarkdown = markdown.replace(/^Effective Date:.+\n?/m, '').trim()

      // Add title
      const titleEl = document.createElement('h1')
      titleEl.className = 'legal-title'
      titleEl.textContent = title
      content.appendChild(titleEl)

      // Add effective date if found
      if (effectiveDate) {
        const dateEl = document.createElement('div')
        dateEl.className = 'legal-effective-date'
        dateEl.textContent = `Effective Date: ${effectiveDate}`
        content.appendChild(dateEl)
      }

      // Convert markdown to HTML (simple conversion)
      const htmlContent = markdownToHtml(contentMarkdown)
      const bodyEl = document.createElement('div')
      bodyEl.className = 'legal-body'
      bodyEl.innerHTML = htmlContent
      content.appendChild(bodyEl)

    } catch (error) {
      const errorEl = document.createElement('div')
      errorEl.className = 'legal-error'
      errorEl.textContent = 'Failed to load content. Please try again later.'
      content.appendChild(errorEl)
    }
  }

  // Enhanced markdown to HTML converter with table support
  const markdownToHtml = (markdown: string): string => {
    let html = markdown

    // Escape HTML first
    html = html.replace(/&/g, '&amp;')
    html = html.replace(/</g, '&lt;')
    html = html.replace(/>/g, '&gt;')

    // Code blocks (must be before inline code)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')

    // Tables
    html = html.replace(/\|(.+)\|[\r\n]+\|[-\s\|]+\|[\r\n]+((?:\|.+[\r\n?]+)+)/g, (match, header, body) => {
      const headerCells = header.split('|').map((cell: string) => cell.trim()).filter((cell: string) => cell)
      const headerHtml = headerCells.map((cell: string) => `<th>${cell}</th>`).join('')
      
      const rows = body.trim().split('\n')
      const bodyHtml = rows.map((row: string) => {
        const cells = row.split('|').map((cell: string) => cell.trim()).filter((cell: string) => cell)
        return `<tr>${cells.map((cell: string) => `<td>${cell}</td>`).join('')}</tr>`
      }).join('')
      
      return `<table class="legal-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`
    })

    // Headers
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

    // Lists (both bullet and numbered)
    html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>')
    html = html.replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>')
    
    // Wrap lists in proper tags
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
      if (match.includes('1.') || match.includes('2.') || match.includes('3.')) {
        return '<ol>' + match + '</ol>'
      }
      return '<ul>' + match + '</ul>'
    })
    
    // Clean up nested lists
    html = html.replace(/<\/ul>\s*<ul>/g, '')
    html = html.replace(/<\/ol>\s*<ol>/g, '')

    // Paragraphs (must be last)
    const lines = html.split('\n')
    let inList = false
    let inTable = false
    let inCode = false
    let inHeader = false
    
    const processedLines = lines.map(line => {
      const trimmedLine = line.trim()
      
      // Skip empty lines
      if (trimmedLine === '') return ''
      
      // Check if we're in special blocks
      if (trimmedLine.startsWith('<table>')) inTable = true
      if (trimmedLine.startsWith('</table>')) { inTable = false; return line }
      if (trimmedLine.startsWith('<pre>')) inCode = true
      if (trimmedLine.startsWith('</pre>')) { inCode = false; return line }
      if (trimmedLine.startsWith('<h')) inHeader = true
      
      // If we're in special blocks, return as-is
      if (inTable || inCode || inHeader) {
        inHeader = !trimmedLine.endsWith('>')
        return line
      }
      
      // Handle lists
      if (trimmedLine.startsWith('<ul>') || trimmedLine.startsWith('<ol>') || trimmedLine.startsWith('<li>')) {
        inList = true
        return line
      }
      if (trimmedLine.startsWith('</ul>') || trimmedLine.startsWith('</ol>')) {
        inList = false
        return line
      }
      if (inList && trimmedLine.startsWith('<li>')) {
        return line
      }
      
      // Reset list state
      inList = false
      
      // Wrap non-tagged lines in paragraphs
      if (!trimmedLine.startsWith('<')) {
        return `<p>${line}</p>`
      }
      
      return line
    })

    html = processedLines.join('\n')

    // Clean up empty paragraphs and excessive whitespace
    html = html.replace(/<p><\/p>/g, '')
    html = html.replace(/\n{3,}/g, '\n\n')

    return html
  }

  // Assemble
  contentWrapper.appendChild(header)
  contentWrapper.appendChild(content)
  container.appendChild(contentWrapper)

  // Load content
  loadContent()

  return {
    getElement: () => container,
    destroy: () => {
      // Cleanup if needed
    }
  }
}
