import { t } from '../lib/i18n.js';
import { loadLinkPreview } from '../lib/link-preview.js';
import {
  createNewChannelKey,
  decryptFileForServer,
  decryptServerText,
  encryptFileForServer,
  encryptServerText,
  ensureChannelKeys,
  fetchUserPublicKeys,
  wrapKeyForMembers,
} from '../lib/messenger-store.js';
import { registerModal } from '../lib/modal-state.js';
import { showToast } from '../lib/toast.js';
import { executeZipAuto } from '../lib/zip-manager.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { executeFlash } from './FlashPlayer.js';
import { linkifyHashtags, linkifyUrls, processText } from './PostText.js';
import type { UserSearchSuggestion } from './ServerModals.js';
import { createModalBase, showConfirmModal, showUserPickerModal } from './ServerModals.js';
import { createVideoPlayer } from './VideoPlayer.js';

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

export interface ServerMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  content: string;
  gif_key?: string | null;
  payload_key?: string | null;
  swf_key?: string | null;
  content_iv?: string | null;
  enc_version?: number | null;
  key_version?: number | null;
  reply_to_id?: string | null;
  pinned: number;
  created_at: string;
  edited_at?: string | null;
  is_mine: boolean;
  sender: {
    id: string;
    username: string;
    display_name: string;
    avatar_key: string | null;
  };
}

export interface ServerViewProps {
  serverId: string;
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onBack: () => void;
  onMenu?: () => void;
  onOpenCreateChannel?: () => void;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class ServerView {
  private element: HTMLElement;
  private props: ServerViewProps;
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
  private messages: ServerMessage[] = [];
  private loading = true;
  private sending = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nextCursor: string | null = null;
  private loadingMore = false;
  private hasMore = true;
  private selectedFile: File | null = null;
  private editingMsgId: string | null = null;
  private memberPanelOpen = !window.matchMedia('(max-width: 768px)').matches;

  constructor(props: ServerViewProps) {
    this.props = props;
    this.element = this.createElement();
    void this.load();
  }

  private canManage(): boolean {
    return this.server.my_role === 'owner' || this.server.my_role === 'admin';
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'server-chat-view';

    // ── Main (message) panel ──
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

    const messagesArea = document.createElement('div');
    messagesArea.id = 'server-messages-area';
    messagesArea.className = 'chat-messages';
    messagesArea.addEventListener('scroll', () => {
      if (messagesArea.scrollTop < 100 && this.hasMore && !this.loadingMore) {
        void this.loadOlderMessages();
      }
    });

    // ── Input ──
    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area server-input-area';

    const fileBtn = document.createElement('button');
    fileBtn.className = 'chat-input-btn';
    fileBtn.textContent = '📎';
    fileBtn.title = t('composer.attach_file');
    fileBtn.addEventListener('click', () => fileInput.click());

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'server-file-input';
    fileInput.style.display = 'none';
    fileInput.accept = '.gif,.jpg,.jpeg,.png,.webp,.mp3,.wav,.ogg,.m4a,.webm,.zip,.swf,.html,.htm';
    fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleFileSelection(file);
    });

    const input = document.createElement('textarea');
    input.id = 'server-message-input';
    input.className = 'server-input chat-input';
    input.rows = 1;
    input.placeholder = t('servers.placeholder');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.sendMessage();
      }
    });
    input.addEventListener('input', () => {
      this.updateCharCount();
      this.autoGrow();
    });

    const sendBtn = document.createElement('button');
    sendBtn.id = 'server-send-btn';
    sendBtn.className = 'chat-send-btn';
    sendBtn.title = t('messages.send');
    sendBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    sendBtn.addEventListener('click', () => void this.sendMessage());

    const charCount = document.createElement('div');
    charCount.id = 'server-char-count';
    charCount.className = 'chat-char-count';

    const filePreview = document.createElement('div');
    filePreview.id = 'server-file-preview';
    filePreview.className = 'chat-file-preview';
    filePreview.style.display = 'none';
    const filePreviewInfo = document.createElement('span');
    filePreviewInfo.className = 'chat-file-preview-info';
    const fileRemoveBtn = document.createElement('button');
    fileRemoveBtn.className = 'chat-file-preview-remove';
    fileRemoveBtn.textContent = '✕';
    fileRemoveBtn.addEventListener('click', () => this.clearFileSelection());
    filePreview.appendChild(filePreviewInfo);
    filePreview.appendChild(fileRemoveBtn);

    inputArea.appendChild(fileBtn);
    inputArea.appendChild(fileInput);
    inputArea.appendChild(input);
    inputArea.appendChild(charCount);
    inputArea.appendChild(sendBtn);
    inputArea.appendChild(filePreview);

    main.appendChild(header);
    main.appendChild(messagesArea);
    main.appendChild(inputArea);

    // ── Member (right) panel ──
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

  private autoGrow(): void {
    const input = this.element.querySelector('#server-message-input') as HTMLTextAreaElement;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  private updateCharCount(): void {
    const input = this.element.querySelector('#server-message-input') as HTMLTextAreaElement;
    const count = this.element.querySelector('#server-char-count') as HTMLElement;
    if (input && count) count.textContent = `${input.value.length}/200`;
  }

  private handleFileSelection(file: File): void {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast(t('composer.error_file_too_large'), true);
      return;
    }
    this.selectedFile = file;
    const preview = this.element.querySelector('#server-file-preview') as HTMLElement;
    const info = this.element.querySelector('.chat-file-preview-info') as HTMLElement;
    if (preview && info) {
      info.textContent = file.name;
      preview.style.display = 'flex';
    }
  }

  private clearFileSelection(): void {
    this.selectedFile = null;
    const preview = this.element.querySelector('#server-file-preview') as HTMLElement;
    const input = this.element.querySelector('#server-file-input') as HTMLInputElement;
    if (preview) preview.style.display = 'none';
    if (input) input.value = '';
  }

  // ─── loading ───────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const res = await fetch(`/api/servers/${this.props.serverId}`, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 404) {
        this.props.onBack();
        return;
      }
      this.loading = false;
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
      // Voice channel: no message history or input — show a join panel instead.
      if (callBtn) callBtn.style.display = '';
      if (inputArea) inputArea.style.display = 'none';
      this.loading = false;
      this.renderVoicePanel(ch);
      return;
    }

    if (callBtn) callBtn.style.display = 'none';
    if (inputArea) inputArea.style.display = '';

    if (ch) await this.ensureChannelReady(ch);

    await this.fetchMessages(true);
    void this.markRead();

    this.startPolling();
  }

  // Show a join screen for a voice channel.
  private renderVoicePanel(ch: ServerChannel): void {
    const area = this.element.querySelector('#server-messages-area') as HTMLElement;
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
      new CustomEvent('startServerCall', {
        detail: { serverId: this.props.serverId, channelId: ch.id },
      }),
    );
  }

  // Ensure the current user has a box for this channel. If none exists and we
  // can manage the server, bootstrap/rotate the channel key for all members.
  private async ensureChannelReady(ch: ServerChannel): Promise<void> {
    const key = await ensureChannelKeys(this.props.serverId, ch.id, ch.key_version);
    if (key) return;
    if (!this.canManage()) return; // cannot bootstrap a shared key as a plain member

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
    // Reload keys so our own box is cached.
    await ensureChannelKeys(this.props.serverId, ch.id, ch.key_version);
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

  private async createChannel(): Promise<void> {
    const type = await this.chooseChannelType();
    if (!type) return;
    const name = await this.promptText(
      t('servers.new_channel'),
      t('servers.channel_name'),
      type === 'voice' ? '' : t('servers.general'),
      '',
    );
    if (!name) return;
    const category =
      type === 'text' ? await this.promptText(t('servers.category'), t('servers.category_placeholder'), '', '') : null;
    try {
      const res = await fetch(`/api/servers/${this.props.serverId}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, category: category || null, position: this.channels.length, type }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        showToast(err.error || t('servers.channel_create_failed'), true);
        return;
      }
      const data = (await res.json()) as { id: string; key_version: number; type?: 'text' | 'voice' };
      const ch: ServerChannel = {
        id: data.id,
        name,
        category: category || null,
        position: this.channels.length,
        key_version: data.key_version,
        type: data.type || type,
        unread_count: 0,
        created_at: new Date().toISOString(),
      };
      this.channels.push(ch);
      if (ch.type === 'text') {
        const memberPublicKeys = await fetchUserPublicKeys(this.members.map((m) => m.id));
        const channelKey = await createNewChannelKey();
        const boxes = await wrapKeyForMembers(channelKey, memberPublicKeys);
        if (boxes.length > 0) {
          await fetch(`/api/servers/${this.props.serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ channelId: ch.id, keyVersion: ch.key_version, boxes }),
          });
        }
      }
      await this.openChannel(ch.id);
    } catch {
      showToast(t('servers.channel_create_failed'), true);
    }
  }

  private chooseChannelType(): Promise<'text' | 'voice' | null> {
    return new Promise((resolve) => {
      const unregister = registerModal();
      const overlay = document.createElement('div');
      overlay.className = 'chat-modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'chat-modal-dialog';
      const head = document.createElement('h3');
      head.className = 'chat-modal-title';
      head.textContent = t('servers.new_channel');
      const row = document.createElement('div');
      row.className = 'chat-modal-row';
      const textBtn = document.createElement('button');
      textBtn.className = 'chat-btn chat-btn--primary';
      textBtn.textContent = '# ' + t('servers.channel_type_text');
      const voiceBtn = document.createElement('button');
      voiceBtn.className = 'chat-btn chat-btn--ghost';
      voiceBtn.textContent = '🔊 ' + t('servers.channel_type_voice');
      row.appendChild(textBtn);
      row.appendChild(voiceBtn);
      dialog.appendChild(head);
      dialog.appendChild(row);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      const destroy = (result: 'text' | 'voice' | null) => {
        unregister();
        overlay.remove();
        resolve(result);
      };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) destroy(null);
      });
      textBtn.addEventListener('click', () => destroy('text'));
      voiceBtn.addEventListener('click', () => destroy('voice'));
    });
  }

  private promptText(title: string, placeholder: string, initial = '', extraPlaceholder = ''): Promise<string | null> {
    return new Promise((resolve) => {
      const unregister = registerModal();
      const overlay = document.createElement('div');
      overlay.className = 'chat-modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'chat-modal-dialog';
      const head = document.createElement('h3');
      head.className = 'chat-modal-title';
      head.textContent = title;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'chat-modal-input';
      input.placeholder = placeholder;
      input.value = initial;
      const extra = document.createElement('input');
      extra.type = 'text';
      extra.className = 'chat-modal-input';
      extra.placeholder = extraPlaceholder;
      const row = document.createElement('div');
      row.className = 'chat-modal-row';
      const cancel = document.createElement('button');
      cancel.className = 'chat-btn chat-btn--ghost';
      cancel.textContent = t('common.cancel');
      const ok = document.createElement('button');
      ok.className = 'chat-btn chat-btn--primary';
      ok.textContent = t('common.ok');
      row.appendChild(cancel);
      row.appendChild(ok);
      dialog.appendChild(head);
      dialog.appendChild(input);
      dialog.appendChild(extra);
      dialog.appendChild(row);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      const destroy = () => {
        unregister();
        overlay.remove();
      };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) destroy();
      });
      cancel.addEventListener('click', () => {
        destroy();
        resolve(null);
      });
      ok.addEventListener('click', () => {
        const v = input.value.trim();
        destroy();
        resolve(v || null);
      });
      setTimeout(() => input.focus(), 50);
    });
  }

  private async deleteChannel(ch: ServerChannel): Promise<void> {
    showConfirmModal(
      t('servers.delete_channel_title'),
      t('servers.delete_channel_message'),
      t('common.delete'),
      async () => {
        const res = await fetch(`/api/servers/${this.props.serverId}/channels/${ch.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (res.ok) {
          this.channels = this.channels.filter((c) => c.id !== ch.id);
          if (this.channels[0]) {
            await this.openChannel(this.channels[0].id);
          } else {
            this.activeChannelId = null;
            this.messages = [];
            this.renderMessages();
          }
        } else {
          const err = (await res.json()) as { error?: string };
          showToast(err.error || t('servers.channel_delete_failed'), true);
        }
      },
    );
  }

  // ─── messages ─────────────────────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.pollNewMessages(), 3000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollNewMessages(): Promise<void> {
    if (this.messages.length === 0 || !this.activeChannelId) return;
    const latestMsg = this.messages[this.messages.length - 1];
    try {
      const res = await fetch(
        `/api/servers/${this.props.serverId}/channels/${this.activeChannelId}/messages?limit=10&cursor=${encodeURIComponent(latestMsg.created_at)}`,
        { credentials: 'include' },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages: ServerMessage[] | null };
      const newMsgs = data.messages || [];
      if (newMsgs.length > 0) {
        const existingIds = new Set(this.messages.map((m) => m.id));
        const added = newMsgs.filter((m) => !existingIds.has(m.id)).reverse();
        if (added.length > 0) {
          this.messages.push(...added);
          this.renderMessages();
          this.scrollToBottom();
          void this.markRead();
        }
      }
    } catch {
      /* ignore */
    }
  }

  private async fetchMessages(initial: boolean): Promise<void> {
    if (!this.activeChannelId) return;
    this.loadingMore = !initial && this.loadingMore;
    this.loading = initial;
    try {
      const cursorParam = this.nextCursor ? `&cursor=${encodeURIComponent(this.nextCursor)}` : '';
      const res = await fetch(
        `/api/servers/${this.props.serverId}/channels/${this.activeChannelId}/messages?limit=50${cursorParam}`,
        { credentials: 'include' },
      );
      if (res.ok) {
        const data = (await res.json()) as { messages: ServerMessage[]; next_cursor: string | null };
        const newMsgs = (data.messages || []).reverse();
        if (initial) this.messages = newMsgs;
        else this.messages = [...newMsgs, ...this.messages];
        this.nextCursor = data.next_cursor;
        this.hasMore = data.next_cursor !== null;
        this.loading = false;
        this.loadingMore = false;
        this.renderMessages();
        if (initial) this.scrollToBottom();
        else {
          const firstId = newMsgs[0]?.id;
          if (firstId) {
            requestAnimationFrame(() => {
              this.element.querySelector(`[data-msg-id="${firstId}"]`)?.scrollIntoView({ block: 'start' });
            });
          }
        }
        return;
      }
    } catch {
      /* ignore */
    }
    this.loading = false;
    this.loadingMore = false;
    this.renderMessages();
    if (initial) this.scrollToBottom();
  }

  private async loadOlderMessages(): Promise<void> {
    if (this.loadingMore || !this.hasMore) return;
    this.loadingMore = true;
    await this.fetchMessages(false);
  }

  private async markRead(): Promise<void> {
    if (!this.activeChannelId) return;
    try {
      await fetch(`/api/servers/${this.props.serverId}/channels/${this.activeChannelId}/read`, {
        method: 'POST',
        credentials: 'include',
      });
      const ch = this.channels.find((c) => c.id === this.activeChannelId);
      if (ch) ch.unread_count = 0;
      window.dispatchEvent(new CustomEvent('serverUnreadChanged'));
    } catch {
      /* ignore */
    }
  }

  private async sendMessage(): Promise<void> {
    const input = this.element.querySelector('#server-message-input') as HTMLTextAreaElement;
    const sendBtn = this.element.querySelector('#server-send-btn') as HTMLButtonElement;
    const content = input?.value?.trim() || '';
    if ((!content && !this.selectedFile) || this.sending || !this.activeChannelId) return;

    const ch = this.channels.find((c) => c.id === this.activeChannelId);
    if (!ch) return;

    this.sending = true;
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
      if (this.editingMsgId) {
        await this.sendEdit(ch, content);
        return;
      }

      let gifKey: string | undefined;
      let payloadKey: string | undefined;
      let swfKey: string | undefined;
      let messageId: string | undefined;
      let contentIv: string | undefined;
      let encVersion: number | undefined;
      let keyVersion: number | undefined;
      let encryptedContent = '';

      // Encrypt text (if we have a channel key).
      if (content) {
        const enc = await encryptServerText(this.props.serverId, ch.id, ch.key_version, content);
        if (enc) {
          encryptedContent = enc.ciphertext;
          contentIv = enc.iv;
          encVersion = 1;
          keyVersion = ch.key_version;
        }
      }

      // Encrypt + upload attachment.
      if (this.selectedFile) {
        const upload = await this.uploadAttachment(
          ch,
          this.selectedFile,
          encryptedContent === '' ? undefined : keyVersion,
        );
        if (!upload) {
          this.sending = false;
          sendBtn.disabled = false;
          sendBtn.style.opacity = '1';
          return;
        }
        messageId = upload.messageId;
        gifKey = upload.gifKey;
        payloadKey = upload.payloadKey;
        swfKey = upload.swfKey;
        if (!contentIv && encVersion) {
          keyVersion = upload.keyVersion;
        }
      }

      const body: Record<string, unknown> = {};
      body.content = encryptedContent || content || '';
      if (gifKey) body.gifKey = gifKey;
      if (payloadKey) body.payloadKey = payloadKey;
      if (swfKey) body.swfKey = swfKey;
      if (messageId) body.messageId = messageId;
      if (contentIv) body.contentIv = contentIv;
      if (encVersion) body.encVersion = encVersion;
      if (keyVersion !== undefined) body.keyVersion = keyVersion;

      const res = await fetch(`/api/servers/${this.props.serverId}/channels/${this.activeChannelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const msg = (await res.json()) as ServerMessage;
        this.messages.push(msg);
        this.renderMessages();
        this.scrollToBottom();
        if (input) input.value = '';
        this.clearFileSelection();
        this.updateCharCount();
        this.autoGrow();
      } else {
        const err = (await res.json()) as { error?: string };
        showToast(err.error || t('messages.send_failed'), true);
      }
    } catch {
      showToast(t('messages.send_failed'), true);
    }

    this.sending = false;
    sendBtn.disabled = false;
    sendBtn.style.opacity = '1';
  }

  private async uploadAttachment(
    ch: ServerChannel,
    file: File,
    keyVersion: number | undefined,
  ): Promise<{ messageId: string; gifKey?: string; payloadKey?: string; swfKey?: string; keyVersion: number } | null> {
    try {
      const prepareRes = await fetch(`/api/servers/${this.props.serverId}/channels/${ch.id}/messages/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ filename: file.name }),
      });
      if (!prepareRes.ok) {
        const err = (await prepareRes.json()) as { error?: string };
        showToast(err.error || t('composer.error_upload_failed'), true);
        return null;
      }
      const prepareData = (await prepareRes.json()) as {
        msgId: string;
        uploadUrl: string;
        gifKey?: string;
        payloadKey?: string;
        swfKey?: string;
      };

      const raw = await file.arrayBuffer();
      const encrypted = await encryptFileForServer(
        this.props.serverId,
        ch.id,
        keyVersion || ch.key_version,
        prepareData.msgId,
        raw,
      );
      if (!encrypted) {
        showToast(t('servers.e2ee_unavailable'), true);
        return null;
      }

      const uploadRes = await fetch(prepareData.uploadUrl, {
        method: 'PUT',
        body: encrypted as unknown as BodyInit,
        credentials: 'include',
      });
      if (!uploadRes.ok) {
        showToast(t('composer.error_upload_failed'), true);
        return null;
      }

      return {
        messageId: prepareData.msgId,
        gifKey: prepareData.gifKey,
        payloadKey: prepareData.payloadKey,
        swfKey: prepareData.swfKey,
        keyVersion: keyVersion || ch.key_version,
      };
    } catch {
      showToast(t('composer.error_upload_failed'), true);
      return null;
    }
  }

  private async sendEdit(ch: ServerChannel, content: string): Promise<void> {
    const msgId = this.editingMsgId || '';
    let bodyContent = content;
    let contentIv: string | undefined;
    let encVersion: number | undefined;
    let keyVersion: number | undefined;

    const enc = await encryptServerText(this.props.serverId, ch.id, ch.key_version, content);
    if (enc) {
      bodyContent = enc.ciphertext;
      contentIv = enc.iv;
      encVersion = 1;
      keyVersion = ch.key_version;
    }

    const res = await fetch(`/api/servers/${this.props.serverId}/channels/${ch.id}/messages/${msgId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content: bodyContent, contentIv, encVersion, keyVersion }),
    });
    if (res.ok) {
      const updated = (await res.json()) as { id: string; edited_at?: string };
      const idx = this.messages.findIndex((m) => m.id === updated.id);
      if (idx !== -1) {
        this.messages[idx].content = bodyContent;
        this.messages[idx].content_iv = contentIv || null;
        this.messages[idx].enc_version = encVersion || null;
        this.messages[idx].key_version = keyVersion || null;
        this.messages[idx].edited_at = updated.edited_at || null;
      }
      this.renderMessages();
      this.cancelEdit();
    } else {
      const err = (await res.json()) as { error?: string };
      showToast(err.error || t('messages.edit_failed'), true);
    }
    const input = this.element.querySelector('#server-message-input') as HTMLTextAreaElement;
    const sendBtn = this.element.querySelector('#server-send-btn') as HTMLButtonElement;
    this.sending = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.opacity = '1';
    }
    if (input) input.value = '';
    this.updateCharCount();
  }

  // ─── rendering ─────────────────────────────────────────────────────────────

  private renderMessages(): void {
    const area = this.element.querySelector('#server-messages-area') as HTMLElement;
    if (!area) return;
    area.innerHTML = '';

    if (this.loading && this.messages.length === 0) {
      const loader = document.createElement('div');
      loader.className = 'chat-loading';
      loader.textContent = t('common.loading');
      area.appendChild(loader);
      return;
    }
    if (this.messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = t('servers.channel_empty');
      area.appendChild(empty);
      return;
    }

    if (this.hasMore) {
      const loadMore = document.createElement('div');
      loadMore.className = 'chat-load-more';
      loadMore.textContent = this.loadingMore ? t('common.loading') : '';
      area.appendChild(loadMore);
    }

    let prevMsg: ServerMessage | null = null;
    let prevDay = '';

    for (const msg of this.messages) {
      const day = new Date(msg.created_at).toDateString();
      if (day !== prevDay) {
        const divider = document.createElement('div');
        divider.className = 'chat-divider';
        const label = document.createElement('span');
        label.className = 'chat-divider-label';
        label.textContent = this.formatDay(msg.created_at);
        divider.appendChild(label);
        area.appendChild(divider);
        prevMsg = null;
      }
      prevDay = day;

      const grouped = this.shouldGroup(prevMsg, msg);
      const row = document.createElement('div');
      row.setAttribute('data-msg-id', msg.id);
      row.className = 'msg-row' + (grouped ? ' msg-row--grouped' : '');

      const avatar = document.createElement('div');
      avatar.className = 'msg-row-avatar';
      if (!grouped && msg.sender?.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${msg.sender.avatar_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else if (!grouped) {
        avatar.textContent = (msg.sender?.display_name || msg.sender?.username || '?').charAt(0).toUpperCase();
      }

      const content = document.createElement('div');
      content.className = 'msg-row-content';

      if (!grouped) {
        const head = document.createElement('div');
        head.className = 'msg-row-head';
        const username = document.createElement('span');
        username.className = 'msg-row-username';
        username.textContent = msg.sender?.display_name || msg.sender?.username || '?';
        const time = document.createElement('span');
        time.className = 'msg-row-time';
        time.textContent = this.formatClock(msg.created_at);
        head.appendChild(username);
        head.appendChild(time);
        if (msg.edited_at) {
          const edited = document.createElement('span');
          edited.className = 'msg-row-edited';
          edited.textContent = t('messages.edited');
          head.appendChild(edited);
        }
        content.appendChild(head);
      }

      const body = document.createElement('div');
      body.className = 'msg-row-body';

      if (msg.gif_key || msg.payload_key || msg.swf_key) {
        const attachment = document.createElement('div');
        attachment.className = 'server-bubble-attachment';
        void this.renderAttachment(attachment, msg);
        body.appendChild(attachment);
      }

      if (msg.content) {
        const text = document.createElement('div');
        text.className = 'msg-row-text';
        const isEnc = !!msg.enc_version && !!msg.content_iv;
        if (isEnc) {
          text.textContent = t('messages.encrypted');
          text.classList.add('msg-row-encrypted');
          void this.decryptTextInto(text, msg);
        } else {
          text.textContent = msg.content;
          void this.enrichText(text, msg.content);
          const previewContainer = document.createElement('div');
          previewContainer.className = 'post-link-preview-container';
          body.appendChild(previewContainer);
          loadLinkPreview(msg.content, previewContainer);
        }
        body.appendChild(text);
      }

      content.appendChild(body);

      if (msg.is_mine) {
        const actions = document.createElement('div');
        actions.className = 'msg-row-actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'msg-row-action';
        editBtn.textContent = t('messages.edit');
        editBtn.addEventListener('click', () => this.startEdit(msg));
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'msg-row-action msg-row-action--danger';
        deleteBtn.textContent = t('common.delete');
        deleteBtn.addEventListener('click', () => void this.confirmDelete(msg));
        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        content.appendChild(actions);
      }

      row.appendChild(avatar);
      row.appendChild(content);
      area.appendChild(row);

      prevMsg = msg;
    }
  }

  private async decryptTextInto(el: HTMLElement, msg: ServerMessage): Promise<void> {
    const ch = this.channels.find((c) => c.id === msg.channel_id);
    if (!ch) return;
    const plain = await decryptServerText(
      this.props.serverId,
      msg.channel_id,
      msg.key_version || ch.key_version,
      msg.content,
      msg.content_iv || '',
    );
    if (!plain) return;
    if (!el.isConnected) return;
    el.classList.remove('msg-row-encrypted');
    el.textContent = plain;
    await this.enrichText(el, plain);
  }

  private async enrichText(el: HTMLElement, content: string): Promise<void> {
    try {
      const html = await processText(content);
      el.innerHTML = html;
      linkifyUrls(el);
      linkifyHashtags(el);
    } catch {
      /* ignore */
    }
  }

  private async renderAttachment(container: HTMLElement, msg: ServerMessage): Promise<void> {
    const gifKey = msg.gif_key;
    const payloadKey = msg.payload_key;
    const swfKey = msg.swf_key;
    const ch = this.channels.find((c) => c.id === msg.channel_id);
    const keyVersion = msg.key_version || ch?.key_version || 1;
    const unlock = async (key: string): Promise<Blob | null> => {
      try {
        const res = await fetch(`/api/servers/files/${key}`, { credentials: 'include' });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const dec = await decryptFileForServer(this.props.serverId, msg.channel_id, keyVersion, msg.id, buf);
        if (!dec) return null;
        const mime = detectBlobMime(key);
        return new Blob([dec], { type: mime });
      } catch {
        return null;
      }
    };

    if (gifKey && /server\/audio\//.test(gifKey)) {
      const blob = await unlock(gifKey);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const player = createAudioPlayer({ gifKey: '', postId: msg.id, src: url } as never);
      player.style.maxWidth = '300px';
      container.appendChild(player);
    } else if (gifKey && /server\/video\//.test(gifKey)) {
      const blob = await unlock(gifKey);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const player = createVideoPlayer({ gifKey: '', postId: msg.id, src: url });
      player.style.maxWidth = '100%';
      container.appendChild(player);
    } else if (gifKey && /server\/gif\//.test(gifKey)) {
      const blob = await unlock(gifKey);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.className = 'image-preview-img';
      img.style.cssText = 'max-width:100%; border-radius:8px; cursor:pointer;';
      img.src = url;
      img.alt = t('image_preview.post_preview', { id: msg.id });
      img.addEventListener('click', () => window.open(url, '_blank'));
      container.appendChild(img);
    } else if (payloadKey && /server\/(zip|html)\//.test(payloadKey)) {
      const blob = await unlock(payloadKey);
      const btn = document.createElement('div');
      btn.className = 'execution-button server-attachment-btn';
      btn.textContent = '📦 ' + t('messages.open_zip');
      if (blob) {
        btn.addEventListener('click', () => this.openZip(blob, msg));
      } else {
        btn.style.opacity = '0.5';
        btn.textContent = t('messages.encrypted');
      }
      container.appendChild(btn);
    } else if (swfKey && /server\/swf\//.test(swfKey)) {
      const blob = await unlock(swfKey);
      const btn = document.createElement('div');
      btn.className = 'execution-button server-attachment-btn';
      if (blob) btn.textContent = '⚡ ' + t('messages.play_flash');
      else {
        btn.textContent = t('messages.encrypted');
        btn.style.opacity = '0.5';
      }
      btn.addEventListener('click', () => this.openSwf(blob, msg));
      container.appendChild(btn);
    }
  }

  private openZip(blob: Blob | null, msg: ServerMessage): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.className = 'server-zip-overlay';
    const modal = document.createElement('div');
    modal.className = 'server-zip-modal';
    const header = document.createElement('div');
    header.className = 'server-zip-header';
    const title = document.createElement('span');
    title.textContent = t('messages.open_zip');
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    const content = document.createElement('div');
    content.className = 'server-zip-content';
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });

    if (!blob) {
      content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">${t('messages.encrypted')}</div>`;
      return;
    }
    const url = URL.createObjectURL(blob);
    void executeZipAuto(msg.id, content, url).catch((err) => {
      console.error('ZIP execution failed:', err);
      content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">${t('post_stage.zip_load_error')}</div>`;
    });
  }

  private openSwf(blob: Blob | null, msg: ServerMessage): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.className = 'server-zip-overlay';
    const modal = document.createElement('div');
    modal.className = 'server-zip-modal';
    const header = document.createElement('div');
    header.className = 'server-zip-header';
    const title = document.createElement('span');
    title.textContent = t('messages.play_flash');
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    const content = document.createElement('div');
    content.className = 'server-zip-content';
    content.style.background = '#000';
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });

    if (!blob) {
      content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">${t('messages.encrypted')}</div>`;
      return;
    }
    void blob
      .arrayBuffer()
      .then((data) => executeFlash(msg.id, content, '', false, data))
      .catch((err) => {
        console.error('Flash execution failed:', err);
        content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">${t('post_stage.flash_load_error')}</div>`;
      });
  }

  private shouldGroup(prev: ServerMessage | null, curr: ServerMessage): boolean {
    if (!prev) return false;
    if (prev.sender_id !== curr.sender_id) return false;
    if (prev.is_mine !== curr.is_mine) return false;
    const p = new Date(prev.created_at).getTime();
    const c = new Date(curr.created_at).getTime();
    if (new Date(prev.created_at).toDateString() !== new Date(curr.created_at).toDateString()) return false;
    return c - p >= 0 && c - p <= 5 * 60 * 1000;
  }

  private startEdit(msg: ServerMessage): void {
    if (!msg.is_mine) return;
    this.editingMsgId = msg.id;
    const input = this.element.querySelector('#server-message-input') as HTMLTextAreaElement;
    const sendBtn = this.element.querySelector('#server-send-btn') as HTMLButtonElement;
    const ch = this.channels.find((c) => c.id === msg.channel_id);
    if (ch && msg.enc_version && msg.content_iv) {
      void decryptServerText(
        this.props.serverId,
        msg.channel_id,
        msg.key_version || ch.key_version,
        msg.content,
        msg.content_iv,
      ).then((plain) => {
        if (plain && input) {
          input.value = plain;
          this.updateCharCount();
          this.autoGrow();
        }
      });
    } else if (input) {
      input.value = msg.content;
      this.updateCharCount();
      this.autoGrow();
    }
    if (sendBtn) {
      sendBtn.title = t('messages.save');
      sendBtn.classList.add('chat-send-btn--edit');
    }
  }

  private cancelEdit(): void {
    this.editingMsgId = null;
    const input = this.element.querySelector('#server-message-input') as HTMLTextAreaElement;
    const sendBtn = this.element.querySelector('#server-send-btn') as HTMLButtonElement;
    if (input) input.value = '';
    if (sendBtn) {
      sendBtn.title = t('messages.send');
      sendBtn.classList.remove('chat-send-btn--edit');
    }
    this.updateCharCount();
    this.autoGrow();
  }

  private async confirmDelete(msg: ServerMessage): Promise<void> {
    showConfirmModal(t('messages.delete_title'), t('messages.delete_message'), t('common.delete'), async () => {
      const res = await fetch(`/api/servers/${this.props.serverId}/channels/${msg.channel_id}/messages/${msg.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        this.messages = this.messages.filter((m) => m.id !== msg.id);
        this.renderMessages();
      } else {
        const err = (await res.json()) as { error?: string };
        showToast(err.error || t('messages.delete_failed'), true);
      }
    });
  }

  // ─── members panel ─────────────────────────────────────────────────────────

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

  private formatDay(createdAt: string): string {
    const date = new Date(createdAt);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return t('time.today');
    if (date.toDateString() === yesterday.toDateString()) return t('time.yesterday');
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  private formatClock(createdAt: string): string {
    return new Date(createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  private scrollToBottom(): void {
    const area = this.element.querySelector('#server-messages-area') as HTMLElement;
    if (!area) return;
    setTimeout(() => {
      if (this.element.isConnected) area.scrollTop = area.scrollHeight;
    }, 300);
    setTimeout(() => {
      if (this.element.isConnected) area.scrollTop = area.scrollHeight;
    }, 1000);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public focusInput(): void {
    const input = this.element.querySelector('#server-message-input') as HTMLTextAreaElement;
    if (input) setTimeout(() => input.focus(), 100);
  }

  public destroy(): void {
    this.stopPolling();
    this.element.remove();
  }
}

function detectBlobMime(key: string): string {
  const name = key.toLowerCase();
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.ogg')) return 'audio/ogg';
  if (name.endsWith('.m4a')) return 'audio/mp4';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.mov')) return 'video/quicktime';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'text/html';
  return 'application/octet-stream';
}
