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

  info.appendChild(displayName)
  info.appendChild(usernameElement)
  info.appendChild(bio)

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

  // Posts feed
  const postsSection = document.createElement('div')
  postsSection.className = 'profile-posts'

  const postsHeading = document.createElement('h2')
  postsHeading.className = 'profile-posts-heading'
  postsHeading.textContent = 'Posts'

  const postsList = document.createElement('div')
  postsList.className = 'profile-posts-list'
  postsList.innerHTML = '<div class="loading-text">Loading posts...</div>'

  postsSection.appendChild(postsHeading)
  postsSection.appendChild(postsList)

  // Assemble page
  container.appendChild(header)
  container.appendChild(statsRow)
  container.appendChild(document.createElement('hr'))
  container.appendChild(actionsRow)
  container.appendChild(document.createElement('hr'))
  container.appendChild(postsSection)

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
        
        if (userData.avatar_key) {
          avatar.style.backgroundImage = `url(/api/images/${userData.avatar_key})`
          avatar.style.backgroundSize = 'cover'
          avatar.style.backgroundPosition = 'center'
          avatar.textContent = ''
        }

        // Load posts
        loadUserPosts()
      } else {
        postsList.innerHTML = '<div class="error-text">User not found</div>'
      }
    } catch (error) {
      console.error('Failed to load user data:', error)
      postsList.innerHTML = '<div class="error-text">Failed to load profile</div>'
    }
  }

  // Load user posts
  const loadUserPosts = async () => {
    try {
      const response = await fetch(`/api/posts?user=${username}`)
      if (response.ok) {
        const data = await response.json() as { posts: any[] }
        renderPosts(data.posts || [])
      } else {
        postsList.innerHTML = '<div class="error-text">Failed to load posts</div>'
      }
    } catch (error) {
      console.error('Failed to load posts:', error)
      postsList.innerHTML = '<div class="error-text">Failed to load posts</div>'
    }
  }

  // Render posts
  const renderPosts = (posts: any[]) => {
    if (posts.length === 0) {
      postsList.innerHTML = '<div class="empty-text">No posts yet</div>'
      return
    }

    postsList.innerHTML = ''
    posts.forEach(post => {
      const postCard = createPostCard(post)
      postsList.appendChild(postCard)
    })
  }

  // Create post card (simplified version)
  const createPostCard = (post: any) => {
    const card = document.createElement('div')
    card.className = 'post-card'
    
    const content = document.createElement('div')
    content.className = 'post-content'
    content.textContent = post.text

    const timestamp = document.createElement('div')
    timestamp.className = 'post-timestamp'
    timestamp.textContent = new Date(post.created_at).toLocaleString()

    card.appendChild(content)
    card.appendChild(timestamp)

    return card
  }

  // Edit profile functionality
  const startEdit = () => {
    if (!userData) return

    isEditing = true

    // Replace display name with input
    const displayNameInput = document.createElement('input')
    displayNameInput.type = 'text'
    displayNameInput.className = 'profile-edit-input'
    displayNameInput.value = userData.display_name
    displayName.replaceWith(displayNameInput)

    // Replace bio with textarea
    const bioTextarea = document.createElement('textarea')
    bioTextarea.className = 'profile-edit-textarea'
    bioTextarea.value = userData.bio || ''
    bio.replaceWith(bioTextarea)

    // Show save/cancel buttons
    const saveButton = document.createElement('button')
    saveButton.className = 'profile-button profile-button--save'
    saveButton.textContent = 'Save'

    const cancelButton = document.createElement('button')
    cancelButton.className = 'profile-button profile-button--cancel'
    cancelButton.textContent = 'Cancel'

    const buttonContainer = document.createElement('div')
    buttonContainer.className = 'profile-edit-buttons'
    buttonContainer.appendChild(saveButton)
    buttonContainer.appendChild(cancelButton)

    actionsRow.replaceWith(buttonContainer)

    // Save changes
    saveButton.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/users/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: displayNameInput.value,
            bio: bioTextarea.value
          })
        })

        if (response.ok) {
          userData.display_name = displayNameInput.value
          userData.bio = bioTextarea.value
          exitEdit()
        } else {
          alert('Failed to save. Please try again.')
        }
      } catch (error) {
        console.error('Failed to update profile:', error)
        alert('Failed to save. Please try again.')
      }
    })

    // Cancel edit
    cancelButton.addEventListener('click', exitEdit)
  }

  const exitEdit = () => {
    isEditing = false

    // Restore display name
    const newDisplayName = document.createElement('div')
    newDisplayName.className = 'profile-display-name'
    newDisplayName.textContent = userData.display_name
    document.querySelector('.profile-edit-input')?.replaceWith(newDisplayName)

    // Restore bio
    const newBio = document.createElement('div')
    newBio.className = 'profile-bio'
    newBio.textContent = userData.bio || ''
    document.querySelector('.profile-edit-textarea')?.replaceWith(newBio)

    // Restore action buttons
    const newActionsRow = document.createElement('div')
    newActionsRow.className = 'profile-actions'
    newActionsRow.appendChild(editButton)
    newActionsRow.appendChild(followButton)
    document.querySelector('.profile-edit-buttons')?.replaceWith(newActionsRow)
  }

  // Event listeners
  editButton.addEventListener('click', startEdit)

  followButton.addEventListener('click', async () => {
    try {
      const action = isFollowing ? 'unfollow' : 'follow'
      const response = await fetch(`/api/users/${username}/${action}`, { method: 'POST' })
      
      if (response.ok) {
        isFollowing = !isFollowing
        followButton.textContent = isFollowing ? 'Unfollow' : 'Follow'
        followButton.className = isFollowing ? 
          'profile-button profile-button--secondary' : 
          'profile-button profile-button--primary'
        
        // Update followers count
        const followersCount = document.querySelector('.stat-number')
        if (followersCount) {
          const currentCount = parseInt(followersCount.textContent || '0')
          followersCount.textContent = String(isFollowing ? currentCount + 1 : currentCount - 1)
        }
      }
    } catch (error) {
      console.error('Failed to toggle follow:', error)
    }
  })

  // Avatar click for upload (only own profile)
  avatar.addEventListener('click', () => {
    if (currentUser?.username === username) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (file) {
          try {
            const formData = new FormData()
            formData.append('avatar', file)
            
            const response = await fetch('/api/users/me/avatar', {
              method: 'POST',
              body: formData
            })
            
            if (response.ok) {
              const data = await response.json() as { avatar_key: string }
              avatar.style.backgroundImage = `url(/api/images/${data.avatar_key})`
              avatar.style.backgroundSize = 'cover'
              avatar.style.backgroundPosition = 'center'
              avatar.textContent = ''
            }
          } catch (error) {
            console.error('Failed to upload avatar:', error)
          }
        }
      }
      input.click()
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
