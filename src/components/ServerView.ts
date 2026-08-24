import { t } from '../lib/i18n.js';
import {
  createNewChannelKey,
  ensureChannelKeys,
  fetchUserPublicKeys,
  reconcileServerChannelKeys,
  wrapKeyForMembers,
} from '../lib/messenger-store.js';
import { showToast } from '../lib/toast.js';
import { MessageView } from './chat/MessageView.js';
import { ServerChannelTransport } from './chat/server.js';
import type { UserSearchSuggestion } from './ServerModals.js';
import { createModalBase, showConfirmModal, showUserPickerModal } from './ServerModals.js';

export interface ServerChannel {
  id: string;
  name: string;
  category: string | null;
  position: number;
  key_version: number;
  type: 'text' | 'voice';
  unread_count: number;
  created_at: string;
}

export interface ServerMember {
  id: string;
  username: string;
  display_name: string;
  avatar_key: string | null;
  role: string;
  joined_at: string;
}

export interface ServerViewProps {
  serverId: string;
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onBack: () => void;
  onMenu?: () => void;
  onOpenCreateChannel?: () => void;
}

export class ServerView extends MessageView {
  private readonly props: ServerViewProps;
  private readonly serverTransport: ServerChannelTransport;
  private server: { name: string; description: string; icon_key: string | null; my_role: string; isFounder: boolean } =
    {
      name: '',
      description: '',
      icon_key: null,
      my_role: 'member',
      isFounder: false,
    };
  private channels: ServerChannel[] = [];
  private members: ServerMember[] = [];
  private activeChannelId: string | null = null;
  private memberPanelOpen = !window.matchMedia('(max-width: 768px)').matches;
  private lastReconcileAt = 0;

  constructor(props: ServerViewProps) {
    super('server');
    this.props = props;
    this.serverTransport = new ServerChannelTransport(props.serverId);
    this.transport = this.serverTransport;
    this.serverTransport.setOnMarkRead(() => {
      const ch = this.channels.find((c) => c.id === this.activeChannelId);
      if (ch) ch.unread_count = 0;
    });
    this.element = this.createElement();
    void this.load();
  }

  protected override emptyStateText(): string {
    return t('servers.channel_empty');
  }

  protected override inputPlaceholder(): string {
    return t('servers.placeholder');
  }

  protected override fileAccept(): string {
    return '.gif,.jpg,.jpeg,.png,.webp,.mp3,.wav,.ogg,.m4a,.webm,.zip,.swf,.html,.htm';
  }

  protected override canSend(): boolean {
    if (!this.activeChannelId) return false;
    const ch = this.channels.find((c) => c.id === this.activeChannelId);
    return !!ch && ch.type !== 'voice';
  }

  protected override showDeleteConfirm(msg: { id: string }, onConfirm: () => void): void {
    showConfirmModal(t('messages.delete_title'), t('messages.delete_message'), t('common.delete'), onConfirm);
  }

  private canManage(): boolean {
    return this.server.my_role === 'owner' || this.server.my_role === 'admin';
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'server-chat-view';

    const main = document.createElement('div');
    main.className = 'server-chat-main chat-message-panel';

    const header = document.createElement('div');
    header.className = 'server-chat-header chat-header';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'chat-header-menu';
    menuBtn.textContent = '≡';
    menuBtn.title = t('messages.menu');
    menuBtn.addEventListener('click', () => this.props.onMenu?.());

    const backBtn = document.createElement('button');
    backBtn.className = 'server-chat-back';
    backBtn.textContent = '←';
    backBtn.title = t('common.back');
    backBtn.addEventListener('click', () => {
      this.stopPolling();
      this.props.onBack();
    });

    const topic = document.createElement('div');
    topic.className = 'chat-header-title';
    const topicName = document.createElement('div');
    topicName.id = 'server-channel-name';
    topicName.className = 'chat-header-name';
    const topicMeta = document.createElement('div');
    topicMeta.id = 'server-channel-meta';
    topicMeta.className = 'chat-header-meta';
    topic.appendChild(topicName);
    topic.appendChild(topicMeta);

    const callBtn = document.createElement('button');
    callBtn.id = 'server-call-btn';
    callBtn.className = 'group-call-btn chat-header-call';
    callBtn.title = t('servers.join_voice');
    callBtn.style.display = 'none';
    callBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    callBtn.addEventListener('click', () => {
      const ch = this.channels.find((c) => c.id === this.activeChannelId);
      if (ch && ch.type === 'voice') this.joinVoiceChannel(ch);
    });

    const membersBtn = document.createElement('button');
    membersBtn.className = 'server-members-toggle';
    membersBtn.textContent = t('servers.members');
    membersBtn.addEventListener('click', () => this.toggleMemberPanel());

    header.appendChild(menuBtn);
    header.appendChild(backBtn);
    header.appendChild(topic);
    header.appendChild(callBtn);
    header.appendChild(membersBtn);

    main.appendChild(header);
    main.appendChild(this.buildMessagesArea());
    main.appendChild(this.buildComposer());

    const memberPanel = document.createElement('aside');
    memberPanel.className = 'server-member-panel' + (this.memberPanelOpen ? ' open' : '');
    const memberPanelTitle = document.createElement('div');
    memberPanelTitle.className = 'server-member-panel-title';
    memberPanelTitle.textContent = t('servers.members').toUpperCase();
    memberPanel.appendChild(memberPanelTitle);

    container.appendChild(main);
    container.appendChild(memberPanel);
    return container;
  }

  // ─── loading ───────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const res = await fetch(`/api/servers/${this.props.serverId}`, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 404) {
        this.props.onBack();
        return;
      }
      this.renderMessages();
      return;
    }
    const data = (await res.json()) as {
      name: string;
      description: string;
      icon_key: string | null;
      my_role: string;
      owner_id: string;
      channels: ServerChannel[];
      members: ServerMember[];
    };
    this.server = {
      name: data.name,
      description: data.description,
      icon_key: data.icon_key,
      my_role: data.my_role,
      isFounder: data.owner_id === this.props.currentUser?.id,
    };
    this.channels = data.channels || [];
    this.members = data.members || [];

    const fallback = this.channels[0] || null;
    const activeId = this.activeChannelId || fallback?.id || null;
    if (activeId) await this.openChannel(activeId);
    else this.renderMessages();
  }

  public async openChannel(channelId: string): Promise<void> {
    this.stopPolling();
    this.activeChannelId = channelId;
    this.messages = [];
    this.nextCursor = null;
    this.loading = true;
    this.editingMsgId = null;
    this.cancelEdit();

    const ch = this.channels.find((c) => c.id === channelId);
    const nameEl = this.element.querySelector('#server-channel-name') as HTMLElement;
    if (nameEl) nameEl.textContent = ch ? `${ch.type === 'voice' ? '🔊' : '#'} ${ch.name}` : '';
    const metaEl = this.element.querySelector('#server-channel-meta') as HTMLElement;
    if (metaEl) metaEl.textContent = this.server.name;

    const callBtn = this.element.querySelector('#server-call-btn') as HTMLElement;
    const inputArea = this.element.querySelector('.server-input-area') as HTMLElement;

    if (ch && ch.type === 'voice') {
      if (callBtn) callBtn.style.display = '';
      if (inputArea) inputArea.style.display = 'none';
      this.loading = false;
      this.renderVoicePanel(ch);
      return;
    }

    if (callBtn) callBtn.style.display = 'none';
    if (inputArea) inputArea.style.display = '';

    if (ch) {
      this.serverTransport.setChannel(ch.id, ch.key_version);
      await this.ensureChannelReady(ch);
    }

    await this.fetchMessages(true);
    void this.markRead();
    this.startPolling();
  }

  private renderVoicePanel(ch: ServerChannel): void {
    const area = this.messagesArea;
    if (!area) return;
    area.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'chat-empty server-voice-panel';
    const icon = document.createElement('div');
    icon.className = 'server-voice-panel-icon';
    icon.textContent = '🔊';
    const label = document.createElement('div');
    label.className = 'server-voice-panel-label';
    label.textContent = t('servers.voice_channel');
    const joinBtn = document.createElement('button');
    joinBtn.className = 'chat-btn chat-btn--primary';
    joinBtn.textContent = t('servers.join_voice');
    joinBtn.addEventListener('click', () => this.joinVoiceChannel(ch));
    wrap.appendChild(icon);
    wrap.appendChild(label);
    wrap.appendChild(joinBtn);
    area.appendChild(wrap);
  }

  private joinVoiceChannel(ch: ServerChannel): void {
    window.dispatchEvent(
      new CustomEvent('startServerCall', { detail: { serverId: this.props.serverId, channelId: ch.id } }),
    );
  }

  private async ensureChannelReady(ch: ServerChannel): Promise<void> {
    const key = await ensureChannelKeys(this.props.serverId, ch.id, ch.key_version);
    if (key) {
      // We hold the channel key: make sure every current member has a wrapped
      // box (delivers the key to members who joined after channel creation,
      // e.g. via an invite link). Server-blind E2EE is preserved.
      void this.reconcileChannel(ch);
      return;
    }
    if (!this.canManage()) return;
    const membersWithKeys = await fetchUserPublicKeys(this.members.map((m) => m.id));
    if (membersWithKeys.size === 0) {
      await ensureChannelKeys.call(null, this.props.serverId, ch.id, ch.key_version);
      return;
    }
    const channelKey = await createNewChannelKey();
    const boxes = await wrapKeyForMembers(channelKey, membersWithKeys);
    if (boxes.length === 0) return;
    try {
      await fetch(`/api/servers/${this.props.serverId}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ channelId: ch.id, keyVersion: ch.key_version, boxes }),
      });
    } catch {
      /* best effort */
    }
    await ensureChannelKeys(this.props.serverId, ch.id, ch.key_version);
  }

  // Wrap the channel key we hold for every current member and upload the boxes.
  // Idempotent: the server upserts, and reconcileServerChannelKeys is a no-op
  // unless we actually have the key cached. Keeps invitees able to decrypt.
  private reconcileChannel(ch: ServerChannel): void {
    const memberIds = this.members.map((m) => m.id);
    if (memberIds.length === 0) return;
    void reconcileServerChannelKeys(this.props.serverId, ch.id, ch.key_version, memberIds);
  }

  // Periodically (throttled) re-distribute the channel key so members who join
  // via an invite link after this view loaded still receive it. We refresh the
  // member list first so newly-joined invitees are included.
  protected override async pollNewMessages(): Promise<void> {
    await super.pollNewMessages();
    const now = Date.now();
    if (now - this.lastReconcileAt < 20000) return;
    this.lastReconcileAt = now;
    const ch = this.channels.find((c) => c.id === this.activeChannelId);
    if (ch) {
      void this.refreshServer().then(() => {
        const current = this.channels.find((c) => c.id === this.activeChannelId);
        if (current) this.reconcileChannel(current);
      });
    }
  }

  private async rotateServerKeys(): Promise<void> {
    if (!this.canManage()) return;
    const memberPublicKeys = await fetchUserPublicKeys(this.members.map((m) => m.id));
    for (const ch of this.channels) {
      const nextVersion = ch.key_version + 1;
      const channelKey = await createNewChannelKey();
      const boxes = await wrapKeyForMembers(channelKey, memberPublicKeys);
      if (boxes.length === 0) continue;
      try {
        await fetch(`/api/servers/${this.props.serverId}/keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ channelId: ch.id, keyVersion: nextVersion, boxes }),
        });
        ch.key_version = nextVersion;
      } catch {
        /* best effort */
      }
    }
  }

  private toggleMemberPanel(): void {
    this.memberPanelOpen = !this.memberPanelOpen;
    const panel = this.element.querySelector('.server-member-panel') as HTMLElement;
    if (panel) panel.classList.toggle('open', this.memberPanelOpen);
  }

  private renderMemberPanel(): void {
    const panel = this.element.querySelector('.server-member-panel') as HTMLElement;
    if (!panel) return;
    Array.from(panel.querySelectorAll(':scope > .server-member-row, :scope > .server-member-actions')).forEach((el) => {
      el.remove();
    });
    for (const member of this.members) {
      const row = document.createElement('div');
      row.className = 'server-member-row';
      const avatar = document.createElement('div');
      avatar.className = 'server-member-row-avatar';
      if (member.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${member.avatar_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else {
        avatar.textContent = (member.display_name || member.username).charAt(0).toUpperCase();
      }
      const info = document.createElement('div');
      info.className = 'server-member-row-info';
      const name = document.createElement('div');
      name.className = 'server-member-row-name';
      name.textContent = member.display_name || member.username;
      info.appendChild(name);
      row.appendChild(avatar);
      row.appendChild(info);
      if (member.role === 'owner') {
        const role = document.createElement('span');
        role.className = 'server-member-row-role';
        role.textContent = '👑';
        row.appendChild(role);
      } else if (member.role === 'admin') {
        const role = document.createElement('span');
        role.className = 'server-member-row-role';
        role.textContent = '🔧';
        row.appendChild(role);
      }
      panel.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.className = 'server-member-actions';
    if (this.canManage()) {
      const addMember = document.createElement('button');
      addMember.className = 'chat-btn chat-btn--ghost';
      addMember.textContent = '+ ' + t('servers.add_members');
      addMember.addEventListener('click', () => this.openAddMembers());
      actions.appendChild(addMember);
      const inviteBtn = document.createElement('button');
      inviteBtn.className = 'chat-btn chat-btn--ghost';
      inviteBtn.textContent = t('servers.create_invite') || '🔗 ' + 'Invite link';
      inviteBtn.addEventListener('click', () => this.openInviteModal());
      actions.appendChild(inviteBtn);
      if (this.server.isFounder || this.server.my_role === 'admin') {
        const settings = document.createElement('button');
        settings.className = 'chat-btn chat-btn--ghost';
        settings.textContent = t('servers.settings');
        settings.addEventListener('click', () => this.openSettings());
        actions.appendChild(settings);
      }
    }
    const leave = document.createElement('button');
    leave.className = 'chat-btn chat-btn--danger';
    leave.textContent = t('servers.leave');
    leave.addEventListener('click', () => this.leaveServer());
    actions.appendChild(leave);
    if (this.server.isFounder) {
      const del = document.createElement('button');
      del.className = 'chat-btn chat-btn--danger';
      del.textContent = t('servers.delete_server');
      del.addEventListener('click', () => this.deleteServer());
      actions.appendChild(del);
    }
    panel.appendChild(actions);
  }

  private async refreshServer(): Promise<void> {
    const res = await fetch(`/api/servers/${this.props.serverId}`, { credentials: 'include' });
    if (res.ok) {
      const data = (await res.json()) as {
        name: string;
        description: string;
        icon_key: string | null;
        my_role: string;
        owner_id: string;
        channels: ServerChannel[];
        members: ServerMember[];
      };
      this.server = {
        name: data.name,
        description: data.description,
        icon_key: data.icon_key,
        my_role: data.my_role,
        isFounder: data.owner_id === this.props.currentUser?.id,
      };
      this.channels = data.channels || [];
      this.members = data.members || [];
    }
  }

  private async openAddMembers(): Promise<void> {
    showUserPickerModal(t('servers.add_members'), {
      excludeIds: new Set(this.members.map((m) => m.id)),
      onPick: async (user: UserSearchSuggestion) => {
        const res = await fetch(`/api/servers/${this.props.serverId}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ memberIds: [user.id] }),
        });
        if (res.ok) {
          showToast(t('servers.member_added'));
          await this.refreshServer();
          await this.rotateServerKeys();
          this.renderMemberPanel();
        } else {
          const err = (await res.json()) as { error?: string };
          showToast(err.error || t('servers.member_add_failed'), true);
        }
      },
    });
  }

  private openInviteModal(): void {
    const { dialog } = createModalBase('chat-modal');
    const head = document.createElement('h3');
    head.className = 'chat-modal-title';
    head.textContent = t('servers.create_invite') || 'Invite link';
    dialog.appendChild(head);

    const form = document.createElement('div');
    form.className = 'chat-modal-form';

    const expLabel = document.createElement('label');
    expLabel.className = 'chat-modal-label';
    expLabel.textContent = t('servers.invite_expires_hours') || 'Expires after (hours)';
    const expInput = document.createElement('input');
    expInput.type = 'number';
    expInput.min = '1';
    expInput.className = 'chat-modal-input';
    expInput.placeholder = '';
    expLabel.appendChild(expInput);
    form.appendChild(expLabel);

    const usesLabel = document.createElement('label');
    usesLabel.className = 'chat-modal-label';
    usesLabel.textContent = t('servers.invite_max_uses') || 'Max uses';
    const usesInput = document.createElement('input');
    usesInput.type = 'number';
    usesInput.min = '1';
    usesInput.className = 'chat-modal-input';
    usesLabel.appendChild(usesInput);
    form.appendChild(usesLabel);

    const createBtn = document.createElement('button');
    createBtn.className = 'chat-btn chat-btn--primary';
    createBtn.textContent = t('servers.invite_create') || 'Create';
    form.appendChild(createBtn);
    dialog.appendChild(form);

    const linkWrap = document.createElement('div');
    linkWrap.className = 'chat-modal-invite-link';
    linkWrap.style.display = 'none';
    dialog.appendChild(linkWrap);

    const listWrap = document.createElement('div');
    listWrap.className = 'chat-modal-invite-list';
    dialog.appendChild(listWrap);

    const renderLink = (url: string) => {
      linkWrap.innerHTML = '';
      linkWrap.style.display = '';
      const lbl = document.createElement('div');
      lbl.className = 'chat-modal-label';
      lbl.textContent = t('servers.invite_link') || 'Invite link';
      const full = `${window.location.origin}${url}`;
      const inp = document.createElement('input');
      inp.className = 'chat-modal-input';
      inp.readOnly = true;
      inp.value = full;
      const copy = document.createElement('button');
      copy.className = 'chat-btn chat-btn--ghost';
      copy.textContent = t('servers.invite_copy') || 'Copy';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(full);
          showToast(t('servers.invite_copied') || 'Copied');
        } catch {
          inp.select();
          showToast(t('servers.invite_copy_failed') || 'Copy failed', true);
        }
      });
      linkWrap.appendChild(lbl);
      linkWrap.appendChild(inp);
      linkWrap.appendChild(copy);
    };

    const renderList = async () => {
      const res = await fetch(`/api/servers/${this.props.serverId}/invites`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as {
        invites: Array<{
          token: string;
          url: string;
          role: string;
          maxUses: number | null;
          useCount: number;
          expiresAt: string | null;
        }>;
      };
      listWrap.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'chat-modal-label';
      title.textContent = t('servers.invite_active') || 'Active invites';
      listWrap.appendChild(title);
      if (!data.invites || data.invites.length === 0) {
        const none = document.createElement('div');
        none.className = 'chat-modal-hint';
        none.textContent = t('servers.invite_none') || 'No invites yet';
        listWrap.appendChild(none);
        return;
      }
      for (const inv of data.invites) {
        const row = document.createElement('div');
        row.className = 'chat-modal-invite-row';
        const info = document.createElement('span');
        info.textContent = `${inv.url} · ${inv.useCount}${inv.maxUses != null ? `/${inv.maxUses}` : ''}`;
        const revoke = document.createElement('button');
        revoke.className = 'chat-btn chat-btn--danger';
        revoke.textContent = t('servers.invite_revoke') || 'Revoke';
        revoke.addEventListener('click', async () => {
          const r = await fetch(`/api/servers/${this.props.serverId}/invites/${inv.token}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          if (r.ok) {
            showToast(t('servers.invite_revoked') || 'Revoked');
            await renderList();
          }
        });
        row.appendChild(info);
        row.appendChild(revoke);
        listWrap.appendChild(row);
      }
    };

    createBtn.addEventListener('click', async () => {
      const expVal = expInput.value.trim();
      const usesVal = usesInput.value.trim();
      const body: Record<string, unknown> = {};
      if (expVal) body.expiresInHours = Number(expVal);
      if (usesVal) body.maxUses = Number(usesVal);
      const res = await fetch(`/api/servers/${this.props.serverId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as { url: string };
        renderLink(data.url);
        showToast(t('servers.invite_created') || 'Created');
        await renderList();
      } else {
        const err = (await res.json()) as { error?: string };
        showToast(err.error || t('servers.invite_copy_failed') || 'Failed', true);
      }
    });

    void renderList();
  }

  private openSettings(): void {
    const { dialog, close } = createModalBase('chat-modal');
    const head = document.createElement('h3');
    head.className = 'chat-modal-title';
    head.textContent = t('servers.settings');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'chat-modal-input';
    nameInput.value = this.server.name;
    nameInput.maxLength = 80;
    const descInput = document.createElement('textarea');
    descInput.className = 'chat-modal-textarea';
    descInput.value = this.server.description;
    descInput.maxLength = 500;
    descInput.rows = 3;
    const row = document.createElement('div');
    row.className = 'chat-modal-row';
    const cancel = document.createElement('button');
    cancel.className = 'chat-btn chat-btn--ghost';
    cancel.textContent = t('common.cancel');
    cancel.addEventListener('click', close);
    const save = document.createElement('button');
    save.className = 'chat-btn chat-btn--primary';
    save.textContent = t('common.save');
    save.addEventListener('click', async () => {
      const res = await fetch(`/api/servers/${this.props.serverId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: nameInput.value.trim(), description: descInput.value.trim() }),
      });
      if (res.ok) {
        showToast(t('servers.settings_saved'));
        close();
        await this.refreshServer();
      } else {
        const err = (await res.json()) as { error?: string };
        showToast(err.error || t('servers.settings_failed'), true);
      }
    });
    row.appendChild(cancel);
    row.appendChild(save);
    dialog.appendChild(head);
    dialog.appendChild(nameInput);
    dialog.appendChild(descInput);
    dialog.appendChild(row);
  }

  private leaveServer(): void {
    const uid = this.props.currentUser?.id;
    if (!uid) return;
    showConfirmModal(t('servers.leave_title'), t('servers.leave_message'), t('servers.leave'), async () => {
      const res = await fetch(`/api/servers/${this.props.serverId}/members/${uid}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('serverUnreadChanged'));
        this.props.onBack();
      } else {
        const err = (await res.json()) as { error?: string };
        showToast(err.error || t('servers.leave_failed'), true);
      }
    });
  }

  private deleteServer(): void {
    showConfirmModal(
      t('servers.delete_server_title'),
      t('servers.delete_server_message'),
      t('servers.delete_server'),
      async () => {
        const res = await fetch(`/api/servers/${this.props.serverId}`, { method: 'DELETE', credentials: 'include' });
        if (res.ok) {
          window.dispatchEvent(new CustomEvent('serverUnreadChanged'));
          this.props.onBack();
        } else {
          const err = (await res.json()) as { error?: string };
          showToast(err.error || t('servers.delete_failed'), true);
        }
      },
    );
  }
}
