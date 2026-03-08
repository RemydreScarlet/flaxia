import { createEditProfileModal } from './EditProfileModal.js'

interface ProfilePageProps {
  username: string
  currentUser: { username: string } | null
}

export function createProfilePage({ username, currentUser }: ProfilePageProps) {
  // Create main container
  const container = document.createElement('div')
  container.className = 'profile-page'

  // Profile header
  const header = document.createElement('div')
  header.className = 'profile-header'

  // Avatar section
  const avatarSection = document.createElement('div')
  avatarSection.className = 'profile-avatar-section'

  const avatar = document.createElement('div')
  avatar.className = 'profile-avatar'
  avatar.textContent = username.charAt(0).toUpperCase()

  const info = document.createElement('div')
  info.className = 'profile-info'

  const displayName = document.createElement('div')
  displayName.className = 'profile-display-name'
  displayName.textContent = 'Loading...'

  const usernameElement = document.createElement('div')
  usernameElement.className = 'profile-username'
  usernameElement.textContent = `@${username}`

  const bio = document.createElement('div')
  bio.className = 'profile-bio'
  bio.textContent = ''

  const joinedDate = document.createElement('div')
  joinedDate.className = 'profile-joined-date'
  joinedDate.style.cssText = 'color: var(--text-muted); font-family: monospace; font-size: 0.875rem; margin-top: 0.5rem;'
  joinedDate.textContent = 'Joined: Loading...'

  info.appendChild(displayName)
  info.appendChild(usernameElement)
  info.appendChild(bio)
  info.appendChild(joinedDate)

  avatarSection.appendChild(avatar)
  avatarSection.appendChild(info)

  header.appendChild(avatarSection)

  // Stats row
  const statsRow = document.createElement('div')
  statsRow.className = 'profile-stats'

  const postsStat = document.createElement('div')
  postsStat.className = 'profile-stat'
  postsStat.innerHTML = '<span class="stat-number">0</span> Posts'

  const followersStat = document.createElement('div')
  followersStat.className = 'profile-stat'
  followersStat.innerHTML = '<span class="stat-number">0</span> Followers'

  const followingStat = document.createElement('div')
  followingStat.className = 'profile-stat'
  followingStat.innerHTML = '<span class="stat-number">0</span> Following'

  statsRow.appendChild(postsStat)
  statsRow.appendChild(followersStat)
  statsRow.appendChild(followingStat)

  // Action buttons
  const actionsRow = document.createElement('div')
  actionsRow.className = 'profile-actions'

  // Edit Profile button (only for own profile)
  const editButton = document.createElement('button')
  editButton.className = 'profile-button profile-button--primary'
  editButton.textContent = 'Edit Profile'
  editButton.style.display = currentUser?.username === username ? 'block' : 'none'

  // Follow/Unfollow button (only for others' profiles)
  const followButton = document.createElement('button')
  followButton.className = 'profile-button profile-button--secondary'
  followButton.textContent = 'Follow'
  followButton.style.display = currentUser?.username === username ? 'none' : 'block'

  actionsRow.appendChild(editButton)
  actionsRow.appendChild(followButton)


  // Assemble page
  container.appendChild(header)
  container.appendChild(statsRow)
  container.appendChild(document.createElement('hr'))
  container.appendChild(actionsRow)

  // State
  let userData: any = null
  let isEditing = false
  let isFollowing = false

  // Load user data
  const loadUserData = async () => {
    try {
      const response = await fetch(`/api/users/${username}`)
      if (response.ok) {
        const data = await response.json() as { user: any }
        userData = data.user
        
        // Update UI
        displayName.textContent = userData.display_name
        bio.textContent = userData.bio || ''
        
        // Format and display joined date
        const joinedDateElement = container.querySelector('.profile-joined-date') as HTMLElement
        if (joinedDateElement && userData.created_at) {
          const joinedDate = new Date(userData.created_at)
          joinedDateElement.textContent = `Joined: ${joinedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
        }
        
        if (userData.avatar_key) {
          avatar.style.backgroundImage = `url(/api/images/${userData.avatar_key})`
          avatar.style.backgroundSize = 'cover'
          avatar.style.backgroundPosition = 'center'
          avatar.textContent = ''
        }

      } else {
        console.error('User not found')
      }
    } catch (error) {
      console.error('Failed to load user data:', error)
    }
  }

  
  // Edit profile functionality
  const startEdit = () => {
    if (!userData) return

    const modal = createEditProfileModal({
      currentUser: userData,
      onSave: async () => {
        // Reload user data after save
        await loadUserData()
      }
    })

    document.body.appendChild(modal.getElement())
  }


  // Event listeners
  editButton.addEventListener('click', startEdit)

  followButton.addEventListener('click', async () => {
    // Stub - follow/unfollow functionality not implemented in this phase
    console.log('Follow/Unfollow clicked (stub)')
  })

  // Load initial data
  loadUserData()

  return {
    getElement: () => container,
    destroy: () => {
      // Cleanup if needed
    }
  }
}
