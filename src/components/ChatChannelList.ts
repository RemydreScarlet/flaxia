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
    enc_version?: number | null;
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

export interface ChannelListServer {
  id: string;
  name: string;
  icon_key?: string | null;
  unread_count?: number;
  my_role?: string;
}

export interface ChannelListServerChannel {
  id: string;
  name: string;
  type?: 'text' | 'voice';
  unread_count?: number;
}

export interface ChatChannelListProps {
  currentUser: ChannelListUser | null;
  activeConversationId?: string | null;
  activeGroupId?: string | null;
  activeServerId?: string | null;
  activeServerChannelId?: string | null;
  onSelectConversation: (convId: string) => void;
  onSelectGroup: (groupId: string) => void;
  onOpenServerChannel: (serverId: string, channelId: string) => void;
  onCreateServer?: () => void;
}

export class ChatChannelList {
  private element: HTMLElement;
  private props: ChatChannelListProps;
  private conversations: ChannelListConversation[] = [];
  private groups: ChannelListGroup[] = [];
  private servers: ChannelListServer[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchResults: ChannelListUser[] = [];
  private searchInputValue = '';
  private searchOpen = false;
  private createOpen = false;
  private selectedMemberIds: string[] = [];
  private selectedMemberNames: Map<string, string> = new Map();
  private groupSearchResults: ChannelListUser[] = [];
  private mobileOverlay: HTMLElement | null = null;
  private expandedServerId: string | null = null;
  private serverChannels: Map<string, ChannelListServerChannel[]> = new Map();
  private loadingServerChannels: Set<string> = new Set();

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

    // Servers section
    const serverSection = document.createElement('section');
    serverSection.className = 'channel-section';

    const serverHead = document.createElement('button');
    serverHead.className = 'channel-section-head';
    const serverHeadLabel = document.createElement('span');
    serverHeadLabel.textContent = t('servers.title').toUpperCase();
    const serverAdd = document.createElement('span');
    serverAdd.className = 'channel-section-add';
    serverAdd.textContent = '+';
    serverAdd.title = t('servers.create');
    serverAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      this.props.onCreateServer?.();
    });
    serverHead.appendChild(serverHeadLabel);
    serverHead.appendChild(serverAdd);

    const serverItems = document.createElement('div');
    serverItems.id = 'channel-server-items';
    serverItems.className = 'channel-section-items';

    serverSection.appendChild(serverHead);
    serverSection.appendChild(serverItems);

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

    body.appendChild(serverSection);
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

  public setActive(
    conversationId: string | null,
    groupId: string | null,
    serverId?: string | null,
    serverChannelId?: string | null,
  ): void {
    this.props.activeConversationId = conversationId;
    this.props.activeGroupId = groupId;
    this.props.activeServerId = serverId ?? null;
    this.props.activeServerChannelId = serverChannelId ?? null;
    this.renderSections();
  }

  // Ensure the given server's channel list is expanded (no-op if already open).
  public async expandServer(serverId: string): Promise<void> {
    if (this.expandedServerId === serverId) return;
    await this.toggleServerExpand(serverId);
  }

  public setMobileOpen(open: boolean): void {
    this.element.classList.toggle('channel-list--open', open);
    if (open) {
      this.ensureOverlay();
    } else {
      this.removeOverlay();
    }
  }

  private ensureOverlay(): void {
    if (this.mobileOverlay) {
      this.mobileOverlay.style.display = 'block';
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'channel-list-overlay';
    overlay.addEventListener('click', () => this.setMobileOpen(false));
    document.body.appendChild(overlay);
    this.mobileOverlay = overlay;
  }

  private removeOverlay(): void {
    if (this.mobileOverlay) {
      this.mobileOverlay.remove();
      this.mobileOverlay = null;
    }
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
    await Promise.all([this.fetchConversations(silent), this.fetchGroups(silent), this.fetchServers(silent)]);
    this.renderSections();
  }

  private async fetchServers(silent: boolean): Promise<void> {
    try {
      const res = await fetch('/api/servers', { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { servers: ChannelListServer[] };
        this.servers = data.servers || [];
      }
    } catch {
      if (!silent) showToast(t('messages.load_failed'), true);
    }
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
    const serverItems = this.element.querySelector('#channel-server-items') as HTMLElement;
    if (serverItems) {
      serverItems.innerHTML = '';
      this.servers.forEach((server) => {
        serverItems.appendChild(this.createServerItem(server));
      });
      if (this.servers.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'channel-section-empty';
        empty.textContent = t('servers.no_servers');
        serverItems.appendChild(empty);
      }
    }
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

  private createServerItem(server: ChannelListServer): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'channel-server-group';

    const row = document.createElement('button');
    row.className = 'channel-item' + (server.id === this.props.activeServerId ? ' channel-item--active' : '');

    const icon = document.createElement('div');
    icon.className = 'chat-avatar-placeholder channel-server-avatar';
    if (server.icon_key) {
      const img = document.createElement('img');
      img.src = `/api/images/${server.icon_key}`;
      img.loading = 'lazy';
      img.alt = server.name;
      img.addEventListener('error', () => {
        img.remove();
        icon.textContent = server.name.charAt(0).toUpperCase();
      });
      icon.appendChild(img);
    } else {
      icon.textContent = server.name.charAt(0).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'channel-item-info';

    const name = document.createElement('div');
    name.className = 'channel-item-name';
    name.textContent = server.name;
    info.appendChild(name);

    const badge = document.createElement('div');
    badge.className = 'channel-item-role';
    badge.textContent =
      server.my_role === 'owner' ? t('servers.role_owner') : server.my_role === 'admin' ? t('servers.role_admin') : '';
    info.appendChild(badge);

    row.appendChild(icon);
    row.appendChild(info);

    const unread = Number(server.unread_count) || 0;
    if (unread > 0) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'channel-item-badge';
      badgeEl.textContent = unread >= 99 ? '99+' : String(unread);
      row.appendChild(badgeEl);
    }

    // Chevron indicating expand/collapse
    const expanded = this.expandedServerId === server.id;
    const chevron = document.createElement('span');
    chevron.className = 'channel-server-chevron' + (expanded ? ' channel-server-chevron--open' : '');
    chevron.textContent = '▸';
    row.appendChild(chevron);

    row.addEventListener('click', () => void this.toggleServerExpand(server.id));
    wrap.appendChild(row);

    if (expanded) {
      const channelsBox = document.createElement('div');
      channelsBox.className = 'channel-server-channels';
      const channels = this.serverChannels.get(server.id);
      if (!channels && this.loadingServerChannels.has(server.id)) {
        const loading = document.createElement('div');
        loading.className = 'channel-section-empty';
        loading.textContent = '…';
        channelsBox.appendChild(loading);
      } else if (channels) {
        for (const ch of channels) {
          channelsBox.appendChild(this.createServerChannelItem(server.id, ch));
        }
        if (channels.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'channel-section-empty';
          empty.textContent = t('servers.no_channels');
          channelsBox.appendChild(empty);
        }
      }
      wrap.appendChild(channelsBox);
    }

    return wrap;
  }

  private async toggleServerExpand(serverId: string): Promise<void> {
    if (this.expandedServerId === serverId) {
      this.expandedServerId = null;
      this.renderSections();
      return;
    }
    this.expandedServerId = serverId;
    if (!this.serverChannels.has(serverId)) {
      this.loadingServerChannels.add(serverId);
      this.renderSections();
      try {
        const res = await fetch(`/api/servers/${serverId}`, { credentials: 'include' });
        if (res.ok) {
          const data = (await res.json()) as { channels?: ChannelListServerChannel[] };
          this.serverChannels.set(serverId, data.channels || []);
        } else {
          this.serverChannels.set(serverId, []);
        }
      } catch {
        this.serverChannels.set(serverId, []);
      } finally {
        this.loadingServerChannels.delete(serverId);
      }
    }
    this.renderSections();
  }

  private createServerChannelItem(serverId: string, ch: ChannelListServerChannel): HTMLElement {
    const row = document.createElement('button');
    row.className =
      'channel-item channel-sub-item' +
      (ch.id === this.props.activeServerChannelId && serverId === this.props.activeServerId
        ? ' channel-item--active'
        : '');
    row.textContent = `${ch.type === 'voice' ? '🔊' : '#'} ${ch.name}`;

    const unread = Number(ch.unread_count) || 0;
    if (unread > 0) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'channel-item-badge';
      badgeEl.textContent = unread >= 99 ? '99+' : String(unread);
      row.appendChild(badgeEl);
    }

    row.addEventListener('click', () => this.props.onOpenServerChannel(serverId, ch.id));
    return row;
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
      const lm = conv.last_message;
      // DM messages are E2EE; the server stores only ciphertext, so never
      // surface the raw envelope in the preview.
      if (lm.enc_version) {
        preview.textContent = prefix + (t('messages.encrypted') || '🔒 暗号化メッセージ');
      } else {
        preview.textContent = prefix + lm.content;
      }
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
    this.removeOverlay();
    this.element.remove();
  }
}

export function createChatChannelList(props: ChatChannelListProps): ChatChannelList {
  return new ChatChannelList(props);
}

export function createMessagesWelcome(onMenu?: () => void): HTMLElement {
  const welcome = document.createElement('div');
  welcome.className = 'messages-welcome';

  const header = document.createElement('div');
  header.className = 'messages-welcome-header';

  const menuBtn = document.createElement('button');
  menuBtn.className = 'chat-header-menu';
  menuBtn.textContent = '≡';
  menuBtn.title = t('messages.menu');
  if (onMenu) menuBtn.addEventListener('click', onMenu);

  const headTitle = document.createElement('div');
  headTitle.className = 'messages-welcome-head-title';
  headTitle.textContent = t('messages.title');

  header.appendChild(menuBtn);
  header.appendChild(headTitle);
  welcome.appendChild(header);

  const body = document.createElement('div');
  body.className = 'messages-welcome-body';

  const icon = document.createElement('div');
  icon.className = 'messages-welcome-icon';
  icon.textContent = '💬';

  const title = document.createElement('h2');
  title.className = 'messages-welcome-title';
  title.textContent = t('messages.select_user');

  const text = document.createElement('p');
  text.className = 'messages-welcome-text';
  text.textContent = t('messages.welcome_hint');

  body.appendChild(icon);
  body.appendChild(title);
  body.appendChild(text);
  welcome.appendChild(body);
  return welcome;
}
