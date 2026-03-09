import { createEditProfileModal } from './EditProfileModal.js'
import { processText, renderMathElements, linkifyHashtags, linkifyUrls } from './PostText.js'

interface ProfilePageProps {
  username: string
  currentUser: { username: string; id: string } | null
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
  const postsCountSpan = document.createElement('span')
  postsCountSpan.className = 'stat-number'
  postsCountSpan.textContent = '0'
  postsStat.appendChild(postsCountSpan)
  postsStat.appendChild(document.createTextNode(' Posts'))

  const followersStat = document.createElement('div')
  followersStat.className = 'profile-stat'
  const followersCountSpan = document.createElement('span')
  followersCountSpan.className = 'stat-number'
  followersCountSpan.textContent = '0'
  followersStat.appendChild(followersCountSpan)
  followersStat.appendChild(document.createTextNode(' Followers'))

  const followingStat = document.createElement('div')
  followingStat.className = 'profile-stat'
  const followingCountSpan = document.createElement('span')
  followingCountSpan.className = 'stat-number'
  followingCountSpan.textContent = '0'
  followingStat.appendChild(followingCountSpan)
  followingStat.appendChild(document.createTextNode(' Following'))

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
        
        // Process bio with Markdown and links
        if (userData.bio) {
          const processedHtml = processText(userData.bio)
          bio.innerHTML = processedHtml
          
          // Render math elements and linkify
          renderMathElements(bio)
          linkifyHashtags(bio)
          linkifyUrls(bio)
        } else {
          bio.textContent = ''
        }
        
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

        // Update follow counts
        followersCountSpan.textContent = String(userData.followers_count || 0)
        followingCountSpan.textContent = String(userData.following_count || 0)
        
        // Update follow button state
        isFollowing = userData.is_following || false
        updateFollowButton()

      } else {
        console.error('User not found')
      }
    } catch (error) {
      console.error('Failed to load user data:', error)
    }
  }

  // Update follow button text and state
  const updateFollowButton = () => {
    followButton.textContent = isFollowing ? 'Following' : 'Follow'
    followButton.className = isFollowing 
      ? 'profile-button profile-button--primary' 
      : 'profile-button profile-button--secondary'
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
    if (!currentUser) {
      // Redirect to login if not authenticated
      window.location.href = '/login'
      return
    }

    if (!userData) return

    // Disable button during operation
    followButton.disabled = true
    followButton.textContent = isFollowing ? 'Unfollowing...' : 'Following...'

    try {
      if (isFollowing) {
        // Unfollow
        const response = await fetch(`/api/users/${username}/follow`, {
          method: 'DELETE',
          credentials: 'include'
        })
        
        if (response.ok) {
          const result = await response.json() as { followers_count: number; following_count: number }
          isFollowing = false
          followersCountSpan.textContent = String(result.followers_count)
          followingCountSpan.textContent = String(result.following_count)
          updateFollowButton()
        } else {
          console.error('Failed to unfollow:', await response.text())
          updateFollowButton()
        }
      } else {
        // Follow
        const response = await fetch(`/api/users/${username}/follow`, {
          method: 'POST',
          credentials: 'include'
        })
        
        if (response.ok) {
          const result = await response.json() as { followers_count: number; following_count: number }
          isFollowing = true
          followersCountSpan.textContent = String(result.followers_count)
          followingCountSpan.textContent = String(result.following_count)
          updateFollowButton()
        } else {
          console.error('Failed to follow:', await response.text())
          updateFollowButton()
        }
      }
    } catch (error) {
      console.error('Follow/unfollow error:', error)
      updateFollowButton()
    } finally {
      followButton.disabled = false
    }
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
