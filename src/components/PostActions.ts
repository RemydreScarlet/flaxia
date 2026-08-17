import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';
import { PostActionsProps } from '../types/post.js';

export function createPostActions(props: PostActionsProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'post-actions';

  // Fresh! button
  const freshButton = createActionButton('fresh', formatCount(props.freshCount), props.isFreshed);
  freshButton.addEventListener('click', props.onFreshToggle);

  // Bookmark button
  const bookmarkButton = createActionButton('bookmark', formatCount(props.bookmarkCount), props.isBookmarked);
  bookmarkButton.addEventListener('click', props.onBookmarkToggle);

  // Reply button
  const replyButton = createActionButton('reply', formatCount(props.replyCount), false);
  replyButton.addEventListener('click', props.onReplyToggle);

  // Impressions button (display only, not clickable)
  const impressionsButton = createActionButton('impressions', formatCount(props.impressions), false);
  impressionsButton.style.cursor = 'default';
  const impressionsIcon = impressionsButton.querySelector('.action-icon') as HTMLElement;
  if (impressionsIcon) {
    impressionsIcon.style.fontSize = '0.75rem';
    impressionsIcon.style.opacity = '0.5';
  }

  // Share button
  const shareButton = createActionButton('share', '0', false);
  shareButton.addEventListener('click', () => {
    if (props.onShare) {
      props.onShare();
    }
  });

  container.appendChild(freshButton);
  container.appendChild(bookmarkButton);
  if (replyButton) {
    container.appendChild(replyButton);
  }
  container.appendChild(shareButton);
  container.appendChild(impressionsButton);

  return container;
}

function createActionButton(
  type: 'fresh' | 'bookmark' | 'reply' | 'share' | 'impressions',
  count: string,
  isActive: boolean,
): HTMLElement {
  const button = document.createElement('button');
  button.className = `action-button action-button--${type}`;
  button.setAttribute('aria-label', t('post_actions.aria_label', { type }));

  if (isActive) {
    button.classList.add('action-button--active');
    // Console debug for Fresh status
    if (type === 'fresh') {
      console.log('Fresh button is active - user has freshed this post. Fresh count:', count);
    }
  }

  // Create icon (universal Lucide icon, not OS-dependent emoji)
  const iconEl = document.createElement('span');
  iconEl.className = 'action-icon';
  iconEl.appendChild(icon(getIconNameForType(type)));

  button.appendChild(iconEl);

  // Add count for fresh and reply buttons only (not for share)
  if (type !== 'share') {
    const countSpan = document.createElement('span');
    countSpan.className = 'action-count';
    countSpan.textContent = count;

    // Add debug styling for freshed posts
    if (type === 'fresh' && isActive) {
      console.log('Applying green color to fresh count for freshed post');
    }

    button.appendChild(countSpan);
  }

  return button;
}

function getIconNameForType(type: 'fresh' | 'bookmark' | 'reply' | 'share' | 'impressions'): IconName {
  switch (type) {
    case 'fresh':
      return 'fresh';
    case 'bookmark':
      return 'bookmark';
    case 'reply':
      return 'reply';
    case 'share':
      return 'share';
    case 'impressions':
      return 'impressions';
    default:
      return 'share';
  }
}
