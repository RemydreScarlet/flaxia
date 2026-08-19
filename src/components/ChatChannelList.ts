import { t } from '../lib/i18n.js';
import { showToast } from '../lib/toast.js';

export interface ChannelListConversation {
  id: string;
  other_user: {
    id: string;
    username: string;
    display_name: string;
    avatar_key: string | null;
  };
  last_message: {
    id: string;
    content: string;
    sender_id: string;
    created_at: string;
    is_mine: boolean;
  } | null;
  unread: boolean;
  updated_at: string;
}

export interface ChannelListGroup {
  id: string;
  name: string;
  icon_key: string | null;
  member_count: number;
  last_message: {
    content: string;
    sender_id: string;
    created_at: string;
    is_mine: boolean;
  } | null;
  unread_count: number;
}

export interface ChannelListUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string | null;
}

export interface ChatChannelListProps {
  currentUser: ChannelListUser | null;
  activeConversationId?: string | null;
  activeGroupId?: string | null;
  onSelectConversation: (convId: string) => void;
  onSelectGroup: (groupId: string) => void;
}

export class ChatChannelList {
  private element: HTMLElement;
  private props: ChatChannelListProps;
  private conversations: ChannelListConversation[] = [];
  private groups: ChannelListGroup[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchResults: ChannelListUser[] = [];
  private searchInputValue = '';
  private searchOpen = false;
  private createOpen = false;
  private selectedMemberIds: string[] = [];
  private selectedMemberNames: Map<string, string> = new Map();
  private groupSearchResults: ChannelListUser[] = [];

  constructor(props: ChatChannelListProps) {
    this.props = props;
    this.element = this.createElement();
    this.fetchAll();
    this.pollTimer = setInterval(() => this.fetchAll(true), 10000);
  }

  private createElement(): HTMLElement {
    const aside = document.createElement('aside');
    aside.className = 'channel-list';

    const top = document.createElement('div');
    top.className = 'channel-list-top';

    const title = document.createElement('div');
    title.className = 'channel-list-title';
    title.textContent = t('messages.title');

    const mobileClose = document.createElement('button');
    mobileClose.className = 'channel-list-close';
    mobileClose.textContent = '✕';
    mobileClose.title = t('common.close');
    mobileClose.addEventListener('click', () => this.setMobileOpen(false));

    top.appendChild(title);
    top.appendChild(mobileClose);

    const body = document.createElement('div');
    body.className = 'channel-list-body';

    // Direct messages section
    const dmSection = document.createElement('section');
    dmSection.className = 'channel-section';

    const dmHead = document.createElement('button');
    dmHead.className = 'channel-section-head';
    const dmHeadLabel = document.createElement('span');
    dmHeadLabel.textContent = t('messages.tab_direct').toUpperCase();
    const dmAdd = document.createElement('span');
    dmAdd.className = 'channel-section-add';
    dmAdd.textContent = '+';
    dmAdd.title = t('messages.new');
    dmAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSearch();
    });
    dmHead.appendChild(dmHeadLabel);
    dmHead.appendChild(dmAdd);
    dmHead.addEventListener('click', () => this.toggleSearch());

    const dmItems = document.createElement('div');
    dmItems.id = 'channel-dm-items';
    dmItems.className = 'channel-section-items';

    dmSection.appendChild(dmHead);
    dmSection.appendChild(dmItems);

    // Groups section
    const groupSection = document.createElement('section');
    groupSection.className = 'channel-section';

    const groupHead = document.createElement('button');
    groupHead.className = 'channel-section-head';
    const groupHeadLabel = document.createElement('span');
    groupHeadLabel.textContent = t('messages.tab_groups').toUpperCase();
    const groupAdd = document.createElement('span');
    groupAdd.className = 'channel-section-add';
    groupAdd.textContent = '+';
    groupAdd.title = t('groups.new');
    groupAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCreateForm();
    });
    groupHead.appendChild(groupHeadLabel);
    groupHead.appendChild(groupAdd);
    groupHead.addEventListener('click', () => this.toggleCreateForm());

    const groupItems = document.createElement('div');
    groupItems.id = 'channel-group-items';
    groupItems.className = 'channel-section-items';

    groupSection.appendChild(groupHead);
    groupSection.appendChild(groupItems);

    body.appendChild(dmSection);
    body.appendChild(groupSection);

    // New DM search panel
    const searchPanel = document.createElement('div');
    searchPanel.id = 'channel-search-panel';
    searchPanel.className = 'channel-panel';
    searchPanel.style.display = 'none';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'channel-search-input';
    searchInput.className = 'channel-panel-input';
    searchInput.placeholder = t('messages.search_user_placeholder');
    searchInput.addEventListener('input', () => {
      this.searchInputValue = searchInput.value;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.searchUsers(searchInput.value), 300);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggleSearch();
    });

    const searchResults = document.createElement('div');
    searchResults.id = 'channel-search-results';
    searchResults.className = 'channel-panel-results';

    searchPanel.appendChild(searchInput);
    searchPanel.appendChild(searchResults);

    // Create group panel
    const createPanel = document.createElement('div');
    createPanel.id = 'channel-create-panel';
    createPanel.className = 'channel-panel';
    createPanel.style.display = 'none';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'channel-create-name';
    nameInput.className = 'channel-panel-input';
    nameInput.placeholder = t('groups.name_placeholder');

    const userSearch = document.createElement('input');
    userSearch.type = 'text';
    userSearch.id = 'channel-create-user-search';
    userSearch.className = 'channel-panel-input';
    userSearch.placeholder = t('groups.search_users');
    userSearch.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.searchGroupUsers(userSearch.value), 300);
    });

    const selectedUsers = document.createElement('div');
    selectedUsers.id = 'channel-create-selected';
    selectedUsers.className = 'channel-create-selected';

    const groupResults = document.createElement('div');
    groupResults.id = 'channel-create-results';
    groupResults.className = 'channel-panel-results';

    const submitBtn = document.createElement('button');
    submitBtn.id = 'channel-create-submit';
    submitBtn.className = 'channel-create-submit';
    submitBtn.textContent = t('groups.create');
    submitBtn.addEventListener('click', () => this.createGroup());

    createPanel.appendChild(nameInput);
    createPanel.appendChild(userSearch);
    createPanel.appendChild(selectedUsers);
    createPanel.appendChild(groupResults);
    createPanel.appendChild(submitBtn);

    aside.appendChild(top);
    aside.appendChild(body);
    aside.appendChild(searchPanel);
    aside.appendChild(createPanel);

    return aside;
  }

  public setActive(conversationId: string | null, groupId: string | null): void {
    this.props.activeConversationId = conversationId;
    this.props.activeGroupId = groupId;
    this.renderSections();
  }

  public setMobileOpen(open: boolean): void {
    this.element.classList.toggle('channel-list--open', open);
  }

  private toggleSearch(): void {
    this.searchOpen = !this.searchOpen;
    this.createOpen = false;
    const panel = this.element.querySelector('#channel-search-panel') as HTMLElement;
    const createPanel = this.element.querySelector('#channel-create-panel') as HTMLElement;
    if (createPanel) createPanel.style.display = 'none';
    if (panel) {
      panel.style.display = this.searchOpen ? 'block' : 'none';
      if (this.searchOpen) {
        const input = this.element.querySelector('#channel-search-input') as HTMLInputElement;
        setTimeout(() => input?.focus(), 50);
      } else {
        this.searchResults = [];
        this.renderSearchResults();
      }
    }
  }

  private toggleCreateForm(): void {
    this.createOpen = !this.createOpen;
    this.searchOpen = false;
    const panel = this.element.querySelector('#channel-create-panel') as HTMLElement;
    const searchPanel = this.element.querySelector('#channel-search-panel') as HTMLElement;
    if (searchPanel) searchPanel.style.display = 'none';
    if (panel) {
      panel.style.display = this.createOpen ? 'block' : 'none';
      if (!this.createOpen) this.clearCreateForm();
    }
  }

  private clearCreateForm(): void {
    const nameInput = this.element.querySelector('#channel-create-name') as HTMLInputElement;
    const userSearch = this.element.querySelector('#channel-create-user-search') as HTMLInputElement;
    const results = this.element.querySelector('#channel-create-results') as HTMLElement;
    if (nameInput) nameInput.value = '';
    if (userSearch) userSearch.value = '';
    if (results) results.innerHTML = '';
    this.groupSearchResults = [];
    this.renderSelectedUsers();
  }

  private renderSelectedUsers(): void {
    const container = this.element.querySelector('#channel-create-selected') as HTMLElement;
    if (!container) return;
    container.innerHTML = '';
    this.selectedMemberIds.forEach((uid) => {
      const name = this.selectedMemberNames.get(uid) || uid;
      const chip = document.createElement('span');
      chip.className = 'channel-chip';
      chip.textContent = name;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'channel-chip-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        this.selectedMemberIds = this.selectedMemberIds.filter((id) => id !== uid);
        this.selectedMemberNames.delete(uid);
        this.renderSelectedUsers();
      });
      chip.appendChild(removeBtn);
      container.appendChild(chip);
    });
  }

  private async searchUsers(query: string): Promise<void> {
    if (!query || query.length < 1) {
      this.searchResults = [];
      this.renderSearchResults();
      return;
    }
    try {
      const res = await fetch('/api/users/suggest?q=' + encodeURIComponent(query), { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { users: ChannelListUser[] };
        this.searchResults = data.users || [];
      }
    } catch {
      this.searchResults = [];
    }
    this.renderSearchResults();
  }

  private renderSearchResults(): void {
    const container = this.element.querySelector('#channel-search-results') as HTMLElement;
    if (!container) return;
    container.innerHTML = '';

    if (this.searchResults.length === 0 && this.searchInputValue.length > 0) {
      const empty = document.createElement('div');
      empty.className = 'channel-panel-empty';
      empty.textContent = t('messages.search_no_results');
      container.appendChild(empty);
      return;
    }

    this.searchResults.forEach((user) => {
      const row = document.createElement('button');
      row.className = 'channel-user-row';
      row.appendChild(this.createAvatar(user.display_name || user.username, user.avatar_key, 32));

      const info = document.createElement('div');
      info.className = 'channel-user-row-info';
      const name = document.createElement('div');
      name.className = 'channel-user-row-name';
      name.textContent = user.display_name || user.username;
      const handle = document.createElement('div');
      handle.className = 'channel-user-row-handle';
      handle.textContent = '@' + user.username;
      info.appendChild(name);
      info.appendChild(handle);
      row.appendChild(info);

      row.addEventListener('click', () => this.startConversation(user.id));
      container.appendChild(row);
    });
  }

  private async searchGroupUsers(query: string): Promise<void> {
    const container = this.element.querySelector('#channel-create-results') as HTMLElement;
    if (!query || query.length < 1) {
      this.groupSearchResults = [];
      if (container) container.innerHTML = '';
      return;
    }
    try {
      const res = await fetch('/api/users/suggest?q=' + encodeURIComponent(query), { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { users: ChannelListUser[] };
        this.groupSearchResults = (data.users || []).filter(
          (u) => u.id !== this.props.currentUser?.id && !this.selectedMemberIds.includes(u.id),
        );
      }
    } catch {
      this.groupSearchResults = [];
    }
    this.renderGroupSearchResults();
  }

  private renderGroupSearchResults(): void {
    const container = this.element.querySelector('#channel-create-results') as HTMLElement;
    if (!container) return;
    container.innerHTML = '';
    if (this.groupSearchResults.length === 0) return;

    this.groupSearchResults.forEach((user) => {
      const row = document.createElement('button');
      row.className = 'channel-user-row';
      row.appendChild(this.createAvatar(user.display_name || user.username, user.avatar_key, 28));

      const info = document.createElement('div');
      info.className = 'channel-user-row-info';
      const name = document.createElement('div');
      name.className = 'channel-user-row-name';
      name.textContent = user.display_name || user.username;
      info.appendChild(name);
      row.appendChild(info);

      row.addEventListener('click', () => {
        if (!this.selectedMemberIds.includes(user.id)) {
          this.selectedMemberIds.push(user.id);
          this.selectedMemberNames.set(user.id, user.display_name || user.username);
          this.renderSelectedUsers();
        }
        const searchInput = this.element.querySelector('#channel-create-user-search') as HTMLInputElement;
        if (searchInput) searchInput.value = '';
        container.innerHTML = '';
      });
      container.appendChild(row);
    });
  }

  private createAvatar(name: string, avatarKey: string | null | undefined, size: number): HTMLElement {
    const avatar = document.createElement('div');
    avatar.className = 'channel-avatar';
    avatar.style.width = `${size}px`;
    avatar.style.height = `${size}px`;
    if (avatarKey) {
      avatar.style.backgroundImage = `url(/api/images/${avatarKey})`;
      avatar.style.backgroundSize = 'cover';
      avatar.textContent = '';
    } else {
      avatar.textContent = name.charAt(0).toUpperCase();
    }
    return avatar;
  }

  private async startConversation(otherUserId: string): Promise<void> {
    try {
      const res = await fetch('/api/dm/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: otherUserId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { id: string };
        this.toggleSearch();
        this.props.onSelectConversation(data.id);
      }
    } catch (e) {
      console.error('Failed to create conversation:', e);
    }
  }

  private async createGroup(): Promise<void> {
    const nameInput = this.element.querySelector('#channel-create-name') as HTMLInputElement;
    const name = nameInput?.value?.trim();
    if (!name) return;

    const submitBtn = this.element.querySelector('#channel-create-submit') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.style.opacity = '0.5';

    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, memberIds: this.selectedMemberIds }),
      });
      if (res.ok) {
        const data = (await res.json()) as { id: string };
        this.toggleCreateForm();
        this.props.onSelectGroup(data.id);
      } else {
        const err = (await res.json()) as { error?: string };
        console.error('Create group failed:', err.error);
      }
    } catch (e) {
      console.error('Failed to create group:', e);
    }

    submitBtn.disabled = false;
    submitBtn.style.opacity = '1';
  }

  private async fetchAll(silent = false): Promise<void> {
    await Promise.all([this.fetchConversations(silent), this.fetchGroups(silent)]);
    this.renderSections();
  }

  private async fetchConversations(silent: boolean): Promise<void> {
    try {
      const res = await fetch('/api/dm/conversations', { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { conversations: ChannelListConversation[] };
        this.conversations = data.conversations || [];
      }
    } catch {
      if (!silent) showToast(t('messages.load_failed'), true);
    }
  }

  private async fetchGroups(silent: boolean): Promise<void> {
    try {
      const res = await fetch('/api/groups', { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { groups: ChannelListGroup[] };
        this.groups = data.groups || [];
      }
    } catch {
      if (!silent) showToast(t('messages.load_failed'), true);
    }
  }

  private renderSections(): void {
    const dmItems = this.element.querySelector('#channel-dm-items') as HTMLElement;
    const groupItems = this.element.querySelector('#channel-group-items') as HTMLElement;
    if (dmItems) {
      dmItems.innerHTML = '';
      this.conversations.forEach((conv) => {
        dmItems.appendChild(this.createConversationItem(conv));
      });
      if (this.conversations.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'channel-section-empty';
        empty.textContent = t('messages.no_conversations');
        dmItems.appendChild(empty);
      }
    }
    if (groupItems) {
      groupItems.innerHTML = '';
      this.groups.forEach((group) => {
        groupItems.appendChild(this.createGroupItem(group));
      });
      if (this.groups.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'channel-section-empty';
        empty.textContent = t('groups.no_groups');
        groupItems.appendChild(empty);
      }
    }
  }

  private createConversationItem(conv: ChannelListConversation): HTMLElement {
    const row = document.createElement('button');
    row.className = 'channel-item' + (conv.id === this.props.activeConversationId ? ' channel-item--active' : '');

    const avatar = this.createAvatar(
      conv.other_user.display_name || conv.other_user.username,
      conv.other_user.avatar_key,
      36,
    );

    const info = document.createElement('div');
    info.className = 'channel-item-info';

    const topRow = document.createElement('div');
    topRow.className = 'channel-item-top';

    const name = document.createElement('div');
    name.className = 'channel-item-name';
    name.textContent = conv.other_user.display_name || conv.other_user.username;
    topRow.appendChild(name);

    if (conv.last_message) {
      const time = document.createElement('div');
      time.className = 'channel-item-time';
      time.textContent = this.formatTime(conv.last_message.created_at);
      topRow.appendChild(time);
    }
    info.appendChild(topRow);

    if (conv.last_message) {
      const preview = document.createElement('div');
      preview.className = 'channel-item-preview';
      const prefix = conv.last_message.is_mine ? t('messages.you') + ': ' : '';
      preview.textContent = prefix + conv.last_message.content;
      info.appendChild(preview);
    }

    row.appendChild(avatar);
    row.appendChild(info);

    if (conv.unread) {
      const badge = document.createElement('span');
      badge.className = 'channel-item-badge';
      badge.textContent = '1';
      row.appendChild(badge);
    }

    row.addEventListener('click', () => this.props.onSelectConversation(conv.id));
    return row;
  }

  private createGroupItem(group: ChannelListGroup): HTMLElement {
    const row = document.createElement('button');
    row.className = 'channel-item' + (group.id === this.props.activeGroupId ? ' channel-item--active' : '');

    const avatar = this.createAvatar(group.name, group.icon_key, 36);

    const info = document.createElement('div');
    info.className = 'channel-item-info';

    const topRow = document.createElement('div');
    topRow.className = 'channel-item-top';

    const name = document.createElement('div');
    name.className = 'channel-item-name';
    name.textContent = group.name;
    topRow.appendChild(name);

    if (group.last_message) {
      const time = document.createElement('div');
      time.className = 'channel-item-time';
      time.textContent = this.formatTime(group.last_message.created_at);
      topRow.appendChild(time);
    }
    info.appendChild(topRow);

    if (group.last_message) {
      const preview = document.createElement('div');
      preview.className = 'channel-item-preview';
      preview.textContent = group.last_message.content;
      info.appendChild(preview);
    }

    row.appendChild(avatar);
    row.appendChild(info);

    if (group.unread_count > 0) {
      const badge = document.createElement('span');
      badge.className = 'channel-item-badge';
      badge.textContent = group.unread_count >= 99 ? '99+' : String(group.unread_count);
      row.appendChild(badge);
    }

    row.addEventListener('click', () => this.props.onSelectGroup(group.id));
    return row;
  }

  private formatTime(createdAt: string): string {
    const date = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return t('messages.just_now');
    if (diffMins < 60) return t('time.minutes_ago', { n: diffMins });
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  public refresh(): void {
    this.fetchAll();
    this.renderSections();
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.element.remove();
  }
}

export function createChatChannelList(props: ChatChannelListProps): ChatChannelList {
  return new ChatChannelList(props);
}

export function createMessagesWelcome(): HTMLElement {
  const welcome = document.createElement('div');
  welcome.className = 'messages-welcome';

  const icon = document.createElement('div');
  icon.className = 'messages-welcome-icon';
  icon.textContent = '💬';

  const title = document.createElement('h2');
  title.className = 'messages-welcome-title';
  title.textContent = t('messages.select_user');

  const text = document.createElement('p');
  text.className = 'messages-welcome-text';
  text.textContent = t('messages.welcome_hint');

  welcome.appendChild(icon);
  welcome.appendChild(title);
  welcome.appendChild(text);
  return welcome;
}
