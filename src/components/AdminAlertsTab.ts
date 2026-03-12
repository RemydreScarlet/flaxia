export interface AdminAlert {
  id: string
  post_id: string
  category: string
  priority: 'critical' | 'high' | 'normal'
  resolved: number
  created_at: string
  dmca_work_description?: string
  dmca_reporter_email?: string
  dmca_sworn?: number
  post_text?: string
  payload_key?: string
}

export interface AdminAlertsTabProps {
  onNavigateToTab: (tab: 'alerts' | 'hidden' | 'users' | 'ads') => void
}

export function createAdminAlertsTab({ onNavigateToTab }: AdminAlertsTabProps) {
  let element: HTMLElement
  let alerts: AdminAlert[] = []

  // Create container immediately
  element = document.createElement('div')
  element.style.cssText = 'max-width: 800px;'

  const fetchAlerts = async () => {
    try {
      const response = await fetch('/api/admin/alerts', { credentials: 'include' })
      if (response.status === 403) {
        return null
      }
      if (!response.ok) {
        throw new Error('Failed to fetch alerts')
      }
      const data = await response.json()
      return data.alerts as AdminAlert[]
    } catch (error) {
      console.error('Fetch alerts error:', error)
      return []
    }
  }

  const resolveAlert = async (alertId: string) => {
    try {
      const response = await fetch(`/api/admin/alerts/${alertId}/resolve`, {
        method: 'POST',
        credentials: 'include'
      })
      if (!response.ok) {
        throw new Error('Failed to resolve alert')
      }
      return true
    } catch (error) {
      console.error('Resolve alert error:', error)
      return false
    }
  }

  const hidePost = async (postId: string, alertId: string) => {
    try {
      const response = await fetch(`/api/admin/posts/${postId}/hide`, {
        method: 'POST',
        credentials: 'include'
      })
      if (!response.ok) {
        throw new Error('Failed to hide post')
      }
      return true
    } catch (error) {
      console.error('Hide post error:', error)
      return false
    }
  }

  const formatTimeAgo = (dateStr: string): string => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  const getPriorityStyle = (priority: string) => {
    switch (priority) {
      case 'critical':
        return { color: '#ef4444', prefix: '🚨' }
      case 'high':
        return { color: '#f59e0b', prefix: '⚠' }
      default:
        return { color: '#94a3b8', prefix: '•' }
    }
  }

  const createAlertRow = (alert: AdminAlert) => {
    const row = document.createElement('div')
    row.style.cssText = `
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    `

    const priorityStyle = getPriorityStyle(alert.priority)

    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    `

    const badge = document.createElement('span')
    badge.style.cssText = `color: ${priorityStyle.color}; font-weight: 600; font-size: 14px;`
    badge.textContent = `${priorityStyle.prefix} ${alert.priority.toUpperCase()}`
    header.appendChild(badge)

    const category = document.createElement('span')
    category.style.cssText = 'color: #94a3b8; font-size: 14px;'
    category.textContent = alert.category
    header.appendChild(category)

    const postId = document.createElement('span')
    postId.style.cssText = 'color: #94a3b8; font-size: 14px;'
    postId.textContent = `post_id: ${alert.post_id}`
    header.appendChild(postId)

    const time = document.createElement('span')
    time.style.cssText = 'color: #64748b; font-size: 14px; margin-left: auto;'
    time.textContent = formatTimeAgo(alert.created_at)
    header.appendChild(time)

    row.appendChild(header)

    if (alert.category === 'copyright' && alert.dmca_work_description) {
      const dmcaInfo = document.createElement('div')
      dmcaInfo.style.cssText = `
        background: #0f172a;
        border-radius: 4px;
        padding: 12px;
        margin-bottom: 12px;
        font-size: 13px;
        color: #94a3b8;
      `
      dmcaInfo.innerHTML = `
        <div>work: "${alert.dmca_work_description}"</div>
        <div>email: "${alert.dmca_reporter_email}"</div>
        <div style="margin-top: 4px;">sworn: ${alert.dmca_sworn ? '✓' : '✗'}</div>
      `
      row.appendChild(dmcaInfo)
    }

    if (alert.category === 'csam' || alert.category === 'malware') {
      const warning = document.createElement('div')
      warning.style.cssText = `
        background: #451a1a;
        border: 1px solid #ef4444;
        border-radius: 4px;
        padding: 12px;
        margin-bottom: 12px;
        font-size: 13px;
        color: #f1f5f9;
      `
      warning.innerHTML = `
        <div style="margin-bottom: 8px;">⚠ Do not open this content. Mark as resolved and delete from R2 manually:</div>
        <code style="background: #0f172a; padding: 8px; border-radius: 4px; display: block; overflow-x: auto;">wrangler r2 object delete flaxia-content --key "${alert.payload_key || ''}"</code>
      `
      row.appendChild(warning)
    }

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;'

    if (alert.category !== 'csam' && alert.category !== 'malware') {
      const viewBtn = document.createElement('button')
      viewBtn.textContent = 'View post'
      viewBtn.style.cssText = `
        background: #334155;
        color: #f1f5f9;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        transition: background 0.2s;
      `
      viewBtn.addEventListener('click', () => {
        window.open(`/posts/${alert.post_id}`, '_blank')
      })
      actions.appendChild(viewBtn)
    }

    const hideBtn = document.createElement('button')
    hideBtn.textContent = 'Hide'
    hideBtn.style.cssText = `
      background: #334155;
      color: #f1f5f9;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `
    hideBtn.addEventListener('click', async () => {
      if (confirm('Hide this post? This cannot be undone without admin access.')) {
        const success = await hidePost(alert.post_id, alert.id)
        if (success) {
          await resolveAlert(alert.id)
          alerts = alerts.filter(a => a.id !== alert.id)
          render()
        }
      }
    })
    actions.appendChild(hideBtn)

    const dismissBtn = document.createElement('button')
    dismissBtn.textContent = 'Dismiss'
    dismissBtn.style.cssText = `
      background: #334155;
      color: #f1f5f9;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `
    dismissBtn.addEventListener('click', async () => {
      const success = await resolveAlert(alert.id)
      if (success) {
        alerts = alerts.filter(a => a.id !== alert.id)
        render()
      }
    })
    actions.appendChild(dismissBtn)

    row.appendChild(actions)

    return row
  }

  const render = async () => {
    element.innerHTML = ''

    const title = document.createElement('h2')
    title.textContent = 'Alerts'
    title.style.cssText = `
      color: #f1f5f9;
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 24px;
    `
    element.appendChild(title)

    if (alerts.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No alerts'
      empty.style.cssText = 'color: #64748b; font-size: 14px; padding: 24px; text-align: center;'
      element.appendChild(empty)
    } else {
      alerts.forEach(alert => {
        element.appendChild(createAlertRow(alert))
      })
    }
  }

  const init = async () => {
    alerts = await fetchAlerts() || []
    await render()
  }

  // Start initialization but don't wait for it
  init()

  return {
    getElement: () => element,
    refresh: async () => {
      alerts = await fetchAlerts() || []
      await render()
    },
    destroy: () => {
      if (element && element.parentNode) {
        element.parentNode.removeChild(element)
      }
    }
  }
}
