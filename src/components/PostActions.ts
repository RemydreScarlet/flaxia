import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';
import { PostActionsProps } from '../types/post.js';

export function createPostActions(props: PostActionsProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'post-actions';

  const leftGroup = document.createElement('div');
  leftGroup.className = 'post-actions-left';

  const rightGroup = document.createElement('div');
  rightGroup.className = 'post-actions-right';

  // Fresh! button
  const freshButton = createActionButton('fresh', formatCount(props.freshCount), props.isFreshed, true);
  freshButton.addEventListener('click', props.onFreshToggle);

  // Reply button
  const replyButton = createActionButton('reply', formatCount(props.replyCount), false, true);
  replyButton.addEventListener('click', props.onReplyToggle);

  // Quote button (no count)
  const quoteButton = createActionButton('quote', '', false, false);
  quoteButton.addEventListener('click', () => {
    if (props.onQuote) props.onQuote();
  });

  // Bookmark button (no count)
  const bookmarkButton = createActionButton('bookmark', '', props.isBookmarked, false);
  bookmarkButton.addEventListener('click', props.onBookmarkToggle);

  // Share button (no count)
  const shareButton = createActionButton('share', '', false, false);
  shareButton.addEventListener('click', () => {
    if (props.onShare) {
      props.onShare();
    }
  });

  // Impressions button (display only, not clickable)
  const impressionsButton = createActionButton('impressions', formatCount(props.impressions), false, true);
  impressionsButton.style.cursor = 'default';
  const impressionsIcon = impressionsButton.querySelector('.action-icon') as HTMLElement;
  if (impressionsIcon) {
    impressionsIcon.style.fontSize = '0.75rem';
    impressionsIcon.style.opacity = '0.5';
  }

  leftGroup.appendChild(freshButton);
  leftGroup.appendChild(replyButton);
  leftGroup.appendChild(quoteButton);

  // Right-aligned group: rightmost impressions, then share, then bookmark
  rightGroup.appendChild(bookmarkButton);
  rightGroup.appendChild(shareButton);
  rightGroup.appendChild(impressionsButton);

  container.appendChild(leftGroup);
  container.appendChild(rightGroup);

  return container;
}

function createActionButton(type: ActionButtonType, count: string, isActive: boolean, showCount: boolean): HTMLElement {
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

  // Add count for fresh, reply and impressions buttons only
  if (showCount) {
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

type ActionButtonType = 'fresh' | 'bookmark' | 'reply' | 'share' | 'impressions' | 'quote';

function getIconNameForType(type: ActionButtonType): IconName {
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
    case 'quote':
      return 'quote';
    default:
      return 'share';
  }
}
