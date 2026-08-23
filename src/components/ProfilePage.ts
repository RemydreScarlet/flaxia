import { clearMeCache } from '../lib/auth-cache.js';
import { safeRemoveFromBody } from '../lib/dom-utils.js';
import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';
import { openPostModal } from '../lib/post-modal.js';
import { Post } from '../types/post.js';
import { createEditProfileModal } from './EditProfileModal.js';
import { createFollowerListModal } from './FollowerListModal.js';
import { createPostCard } from './PostCard.js';
import { linkifyHashtags, linkifyUrls, processText, renderMathElements } from './PostText.js';
import { showSignInPrompt } from './SignInPrompt.js';
import { CurrentUser, createUserPostList } from './UserPostList.js';

interface ProfilePageProps {
  username: string;
  currentUser: CurrentUser | null;
  sandboxOrigin: string;
}

interface ProfileUserData {
  username: string;
  display_name?: string;
  bio?: string;
  avatar_key?: string | null;
  header_key?: string | null;
  created_at?: string;
  pinned_post_id?: string | null;
  posts_count?: number;
  followers_count?: number;
  following_count?: number;
  is_following?: boolean;
}

export function createProfilePage({ username, currentUser, sandboxOrigin }: ProfilePageProps) {
  // Create main container
  const container = document.createElement('div');
  container.className = 'profile-page';

  // Top bar with back button
  const topBar = document.createElement('div');
  topBar.style.cssText = `
    display: flex;
    align-items: center;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    z-index: 10;
  `;

  const backBtn = document.createElement('button');
  backBtn.textContent = '←';
  backBtn.style.cssText = `
    background: none;
    border: none;
    color: var(--text-primary, inherit);
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    font-size: 1.2rem;
    border-radius: 0.5rem;
    transition: background 0.2s;
  `;
  backBtn.addEventListener('mouseenter', () => {
    backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
  });
  backBtn.addEventListener('mouseleave', () => {
    backBtn.style.background = 'none';
  });
  backBtn.addEventListener('click', () => window.history.back());
  topBar.appendChild(backBtn);

  const topTitle = document.createElement('span');
  topTitle.textContent = `@${username}`;
  topTitle.style.cssText = `
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-left: 0.25rem;
  `;
  topBar.appendChild(topTitle);

  container.appendChild(topBar);

  // Profile header banner (header image)
  const bannerEl = document.createElement('div');
  bannerEl.className = 'profile-banner';

  const bannerOverlay = document.createElement('div');
  bannerOverlay.className = 'profile-banner-overlay';
  bannerOverlay.textContent = t('profile.change_header');
  bannerEl.appendChild(bannerOverlay);

  // Profile header
  const header = document.createElement('div');
  header.className = 'profile-header';

  // Avatar section
  const avatarSection = document.createElement('div');
  avatarSection.className = 'profile-avatar-section';

  const avatar = document.createElement('div');
  avatar.className = 'profile-avatar';
  avatar.textContent = username.charAt(0).toUpperCase();

  const info = document.createElement('div');
  info.className = 'profile-info';

  const displayName = document.createElement('div');
  displayName.className = 'profile-display-name';
  displayName.textContent = t('profile.loading');

  const usernameElement = document.createElement('div');
  usernameElement.className = 'profile-username';
  usernameElement.textContent = `@${username}`;

  const bio = document.createElement('div');
  bio.className = 'profile-bio';
  bio.textContent = '';

  const joinedDate = document.createElement('div');
  joinedDate.className = 'profile-joined-date';
  joinedDate.style.cssText =
    "color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 0.875rem; margin-top: 0.5rem;";
  joinedDate.textContent = t('profile.joined', { date: t('common.loading') });

  info.appendChild(displayName);
  info.appendChild(usernameElement);
  info.appendChild(bio);
  info.appendChild(joinedDate);

  avatarSection.appendChild(avatar);
  avatarSection.appendChild(info);

  header.appendChild(avatarSection);

  // Stats row
  const statsRow = document.createElement('div');
  statsRow.className = 'profile-stats';

  const postsStat = document.createElement('div');
  postsStat.className = 'profile-stat';
  const postsCountSpan = document.createElement('span');
  postsCountSpan.className = 'stat-number';
  postsCountSpan.textContent = '0';
  postsStat.appendChild(postsCountSpan);
  postsStat.appendChild(document.createTextNode(' ' + t('profile.posts_label')));

  const followersStat = document.createElement('div');
  followersStat.className = 'profile-stat';
  followersStat.style.cssText = 'cursor: pointer; transition: background-color 0.2s;';
  const followersCountSpan = document.createElement('span');
  followersCountSpan.className = 'stat-number';
  followersCountSpan.textContent = '0';
  followersStat.appendChild(followersCountSpan);
  followersStat.appendChild(document.createTextNode(' ' + t('profile.followers_label')));

  const followingStat = document.createElement('div');
  followingStat.className = 'profile-stat';
  followingStat.style.cssText = 'cursor: pointer; transition: background-color 0.2s;';
  const followingCountSpan = document.createElement('span');
  followingCountSpan.className = 'stat-number';
  followingCountSpan.textContent = '0';
  followingStat.appendChild(followingCountSpan);
  followingStat.appendChild(document.createTextNode(' ' + t('profile.following_label')));

  statsRow.appendChild(postsStat);
  statsRow.appendChild(followersStat);
  statsRow.appendChild(followingStat);

  const own = currentUser?.username === username;

  let userData: ProfileUserData | null = null;

  // Edit / Logout menu items (only for own profile)
  const editButton = document.createElement('button');
  editButton.className = 'profile-menu-item';
  editButton.textContent = t('profile.edit');

  const logoutButton = document.createElement('button');
  logoutButton.className = 'profile-menu-item';
  logoutButton.textContent = t('profile.log_out');

  // Follow/Unfollow button (only for others' profiles)
  const followButton = document.createElement('button');
  followButton.className = 'profile-button profile-button--secondary';
  followButton.textContent = t('profile.follow');
  followButton.style.display = own ? 'none' : 'block';

  // Action buttons row (follow button, only for others' profiles)
  const actionsRow = document.createElement('div');
  actionsRow.className = 'profile-actions';
  actionsRow.appendChild(followButton);

  // Assemble page
  container.appendChild(header);
  container.insertBefore(bannerEl, header);
  container.appendChild(statsRow);

  if (!own) {
    container.appendChild(document.createElement('hr'));
    container.appendChild(actionsRow);
  }

  // Pinned post container (shown above the tabs for everyone)
  const pinnedContainer = document.createElement('div');
  pinnedContainer.className = 'profile-pinned';
  pinnedContainer.style.display = 'none';

  // User post list (投稿 tab)
  const postList = createUserPostList({
    username: username,
    sandboxOrigin: sandboxOrigin,
    currentUser: currentUser,
    showPinOption: own,
    onTogglePin: own ? togglePin : undefined,
  });

  // Profile tabs (own profile: 投稿 / いいね / ブックマーク)
  const tabBar = document.createElement('div');
  tabBar.className = 'profile-tabs';
  tabBar.style.display = own ? 'flex' : 'none';

  type ProfileTabKey = 'posts' | 'freshs' | 'bookmarks';
  const tabDefs: { key: ProfileTabKey; label: string }[] = [
    { key: 'posts', label: own ? t('profile.your_posts') : t('profile.posts_label') },
    { key: 'freshs', label: t('profile.view_likes') },
    { key: 'bookmarks', label: t('profile.view_bookmarks') },
  ];

  let activeTab: ProfileTabKey = 'posts';
  const tabEls: Partial<Record<ProfileTabKey, HTMLElement>> = {};

  const tabContent = document.createElement('div');
  tabContent.className = 'profile-tab-content';

  const selectTab = (key: ProfileTabKey) => {
    if (key === activeTab) return;

    const current = tabEls[activeTab];
    if (current) current.style.display = 'none';

    let next = tabEls[key];
    if (!next) {
      next = createUserPostList({
        username,
        sandboxOrigin,
        currentUser,
        source: key,
      }).getElement();
      tabEls[key] = next;
      tabContent.appendChild(next);
    }

    next.style.display = '';
    activeTab = key;

    tabBar.querySelectorAll<HTMLElement>('.profile-tab').forEach((el) => {
      el.classList.toggle('profile-tab--active', el.dataset.tab === key);
    });
  };

  tabDefs.forEach((def) => {
    const tab = document.createElement('button');
    tab.className = 'profile-tab';
    tab.dataset.tab = def.key;
    tab.textContent = def.label;
    if (def.key === activeTab) tab.classList.add('profile-tab--active');
    tab.addEventListener('click', () => selectTab(def.key));
    tabBar.appendChild(tab);
  });

  // Posts tab wraps the pinned post (top) + the user's posts list
  const postsTabContent = document.createElement('div');
  postsTabContent.className = 'profile-posts-tab';
  postsTabContent.appendChild(pinnedContainer);
  postsTabContent.appendChild(postList.getElement());
  tabEls.posts = postsTabContent;
  tabContent.appendChild(postsTabContent);

  container.appendChild(tabBar);
  container.appendChild(tabContent);

  // Pinned post logic
  let pinnedPostCache: Post | null = null;

  const renderPinned = () => {
    pinnedContainer.innerHTML = '';

    if (!userData?.pinned_post_id) {
      pinnedContainer.style.display = 'none';
      return;
    }

    pinnedContainer.style.display = '';

    const label = document.createElement('div');
    label.className = 'profile-pinned-label';
    label.textContent = t('profile.pinned_label');
    pinnedContainer.appendChild(label);

    const pinnedPost = pinnedPostCache;
    if (!pinnedPost) return;

    const card = createPostCard({
      post: pinnedPost,
      sandboxOrigin,
      currentUser,
      depth: pinnedPost.depth,
      enablePostRefs: true,
      showPinOption: own,
      pinned: own,
      onTogglePin: own ? togglePin : undefined,
    });
    pinnedContainer.appendChild(card.getElement());
  };

  const loadPinned = async () => {
    try {
      const res = await fetch(`/api/users/${username}/pinned`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { post: Post | null };
      pinnedPostCache = data.post ?? null;
      renderPinned();
    } catch (error) {
      console.error('Failed to load pinned post:', error);
    }
  };

  async function togglePin(postId: string) {
    if (!currentUser) return;
    const currentlyPinned = userData?.pinned_post_id === postId;
    try {
      const res = currentlyPinned
        ? await fetch('/api/profile/pin', { method: 'DELETE', credentials: 'include' })
        : await fetch('/api/profile/pin', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId }),
          });
      if (!res.ok) return;
      const newPinnedId = currentlyPinned ? null : postId;
      userData = userData ? { ...userData, pinned_post_id: newPinnedId } : userData;
      await loadPinned();
      window.dispatchEvent(new CustomEvent('profilePinChanged', { detail: { pinnedId: newPinnedId } }));
    } catch (error) {
      console.error('Failed to toggle pin:', error);
    }
  }

  // Kebab menu (own profile) in the top bar
  if (own) {
    const menu = document.createElement('div');
    menu.className = 'profile-kebab-menu';
    menu.appendChild(editButton);
    menu.appendChild(logoutButton);

    const kebab = document.createElement('button');
    kebab.className = 'profile-kebab-button';
    kebab.textContent = '⋯';
    kebab.setAttribute('aria-label', t('common.menu'));

    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
    window.addEventListener('click', () => {
      menu.style.display = 'none';
    });

    editButton.addEventListener('click', () => {
      menu.style.display = 'none';
    });
    logoutButton.addEventListener('click', () => {
      menu.style.display = 'none';
    });

    bannerEl.classList.add('profile-banner--editable');
    bannerEl.addEventListener('click', () => startEdit());

    topBar.appendChild(kebab);
    topBar.appendChild(menu);
  }

  let fabButton: HTMLElement | null = null;
  if (currentUser) {
    fabButton = document.createElement('button');
    fabButton.className = 'timeline-fab visible';
    fabButton.textContent = '+';
    fabButton.addEventListener('click', () => {
      openPostModal({
        currentUser,
        onPostCreated: (post) => {
          postList.addPost(post as unknown as Post);
        },
      });
    });
    container.appendChild(fabButton);
  }

  const _isEditing = false;
  let isFollowing = false;

  // Load user data
  const loadUserData = async () => {
    try {
      const response = await fetch(`/api/users/${username}`);
      if (response.ok) {
        const data = (await response.json()) as { user: ProfileUserData };
        userData = data.user;

        // Load the pinned post and sync pin state on visible cards
        loadPinned();
        window.dispatchEvent(
          new CustomEvent('profilePinChanged', { detail: { pinnedId: userData.pinned_post_id ?? null } }),
        );

        // Update UI
        displayName.textContent = userData.display_name ?? null;

        // Process bio with Markdown and links
        if (userData.bio) {
          processText(userData.bio)
            .then((processedHtml) => {
              bio.replaceChildren();
              const template = document.createElement('template');
              template.innerHTML = processedHtml;
              bio.appendChild(template.content.cloneNode(true));

              // Render math elements and linkify
              renderMathElements(bio);
              linkifyHashtags(bio);
              linkifyUrls(bio);
            })
            .catch((error) => {
              console.error('Failed to process bio:', error);
              bio.textContent = userData?.bio ?? null;
            });
        } else {
          bio.textContent = '';
        }

        // Format and display joined date
        const joinedDateElement = container.querySelector('.profile-joined-date') as HTMLElement;
        if (joinedDateElement && userData.created_at) {
          const joinedDate = new Date(userData.created_at);
          joinedDateElement.textContent = t('profile.joined', {
            date: joinedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
          });
        }

        if (userData.avatar_key) {
          avatar.style.backgroundImage = `url(/api/images/${userData.avatar_key})`;
          avatar.style.backgroundSize = 'cover';
          avatar.style.backgroundPosition = 'center';
          avatar.textContent = '';
        }

        if (userData.header_key) {
          bannerEl.style.backgroundImage = `url(/api/images/${userData.header_key})`;
        } else {
          bannerEl.style.backgroundImage = '';
        }

        // Update counts
        postsCountSpan.textContent = formatCount(userData.posts_count || 0);
        followersCountSpan.textContent = formatCount(userData.followers_count || 0);
        followingCountSpan.textContent = formatCount(userData.following_count || 0);

        // Update follow button state
        isFollowing = userData.is_following || false;
        updateFollowButton();
      } else {
        console.error('User not found');
      }
    } catch (error) {
      console.error('Failed to load user data:', error);
    }
  };

  // Update follow button text and state
  const updateFollowButton = () => {
    followButton.textContent = isFollowing ? t('profile.following') : t('profile.follow');
    followButton.className = isFollowing
      ? 'profile-button profile-button--primary'
      : 'profile-button profile-button--secondary';
  };

  // Edit profile functionality
  const startEdit = () => {
    if (!userData) return;

    const modal = createEditProfileModal({
      currentUser: userData as {
        username: string;
        display_name?: string;
        bio?: string;
        avatar_key?: string;
        header_key?: string | null;
      },
      onSave: async () => {
        // Reload user data after save
        await loadUserData();
      },
    });

    document.body.appendChild(modal.getElement());
  };

  // Event listeners
  editButton.addEventListener('click', startEdit);

  // Logout functionality
  logoutButton.addEventListener('click', () => {
    if (!currentUser) return;

    // Create confirmation modal
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.setAttribute(
      'style',
      `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    `,
    );

    const modal = document.createElement('div');
    modal.setAttribute(
      'style',
      `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      max-width: 320px;
      width: 90%;
      text-align: center;
    `,
    );

    modal.innerHTML = `
      <h3 style="margin: 0 0 1rem 0; color: var(--text-primary); font-size: 1.125rem;">${t('profile.logout_title', { username: currentUser.username })}</h3>
      <div style="display: flex; gap: 0.75rem; justify-content: center;">
        <button class="logout-cancel-btn" style="
          padding: 0.5rem 1rem;
          background: var(--bg-secondary);
          color: var(--text-primary);
          border: 1px solid var(--border);
          border-radius: 9999px;
          cursor: pointer;
          font-size: 0.875rem;
          transition: background-color 0.2s;
        ">${t('common.cancel')}</button>
        <button class="logout-confirm-btn" style="
          padding: 0.5rem 1rem;
          background: var(--text-primary);
          color: var(--bg-primary);
          border: none;
          border-radius: 9999px;
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 600;
          transition: opacity 0.2s;
        ">${t('auth.sign_out')}</button>
      </div>
    `;

    const cancelBtn = modal.querySelector('.logout-cancel-btn') as HTMLButtonElement;
    const confirmBtn = modal.querySelector('.logout-confirm-btn') as HTMLButtonElement;

    cancelBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });

    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.backgroundColor = 'var(--bg-tertiary)';
    });
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.backgroundColor = 'var(--bg-secondary)';
    });

    confirmBtn.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include',
        });

        if (response.ok) {
          clearMeCache();
          window.location.href = '/';
        } else {
          console.error('Logout failed');
          unregister();
          overlay.remove();
        }
      } catch (error) {
        console.error('Logout error:', error);
        unregister();
        overlay.remove();
      }
    });

    confirmBtn.addEventListener('mouseenter', () => {
      confirmBtn.style.opacity = '0.8';
    });
    confirmBtn.addEventListener('mouseleave', () => {
      confirmBtn.style.opacity = '1';
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });

  followButton.addEventListener('click', async () => {
    if (!currentUser) {
      // Show sign-in prompt for guests
      showSignInPrompt(
        'follow',
        () => {
          window.history.pushState({}, '', '/login');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        () => {
          window.history.pushState({}, '', '/register');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
      );
      return;
    }

    if (!userData) return;

    // Disable button during operation
    followButton.disabled = true;
    followButton.textContent = isFollowing ? t('profile.unfollowing') : t('profile.following');

    try {
      if (isFollowing) {
        // Unfollow
        const response = await fetch(`/api/users/${username}/follow`, {
          method: 'DELETE',
          credentials: 'include',
        });

        if (response.ok) {
          const result = (await response.json()) as { followers_count: number; following_count: number };
          isFollowing = false;
          followersCountSpan.textContent = formatCount(result.followers_count);
          followingCountSpan.textContent = formatCount(result.following_count);
          updateFollowButton();
        } else {
          console.error('Failed to unfollow:', await response.text());
          updateFollowButton();
        }
      } else {
        // Follow
        const response = await fetch(`/api/users/${username}/follow`, {
          method: 'POST',
          credentials: 'include',
        });

        if (response.ok) {
          const result = (await response.json()) as { followers_count: number; following_count: number };
          isFollowing = true;
          followersCountSpan.textContent = formatCount(result.followers_count);
          followingCountSpan.textContent = formatCount(result.following_count);
          updateFollowButton();
        } else {
          console.error('Failed to follow:', await response.text());
          updateFollowButton();
        }
      }
    } catch (error) {
      console.error('Follow/unfollow error:', error);
      updateFollowButton();
    } finally {
      followButton.disabled = false;
    }
  });

  // Add click handlers for follower/following stats
  followersStat.addEventListener('click', () => {
    const modal = createFollowerListModal({
      username: username,
      initialTab: 'followers',
      currentUser: currentUser,
      onClose: () => {
        safeRemoveFromBody(modal.getElement());
      },
    });
    document.body.appendChild(modal.getElement());
  });

  followersStat.addEventListener('mouseenter', () => {
    followersStat.style.backgroundColor = 'var(--bg-secondary)';
  });
  followersStat.addEventListener('mouseleave', () => {
    followersStat.style.backgroundColor = 'transparent';
  });

  followingStat.addEventListener('click', () => {
    const modal = createFollowerListModal({
      username: username,
      initialTab: 'following',
      currentUser: currentUser,
      onClose: () => {
        safeRemoveFromBody(modal.getElement());
      },
    });
    document.body.appendChild(modal.getElement());
  });

  followingStat.addEventListener('mouseenter', () => {
    followingStat.style.backgroundColor = 'var(--bg-secondary)';
  });
  followingStat.addEventListener('mouseleave', () => {
    followingStat.style.backgroundColor = 'transparent';
  });

  // Load initial data
  loadUserData();

  return {
    getElement: () => container,
    destroy: () => {
      // Cleanup post list
      postList.destroy();
    },
  };
}
