import { t } from '../lib/i18n.js';
import { loadLinkPreview } from '../lib/link-preview.js';
import { registerModal } from '../lib/modal-state.js';
import { showToast } from '../lib/toast.js';
import { executeZipAuto } from '../lib/zip-manager.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { executeFlash } from './FlashPlayer.js';
import { createImagePreview } from './ImagePreview.js';
import { linkifyHashtags, linkifyUrls, processText } from './PostText.js';
import { createVideoPlayer } from './VideoPlayer.js';

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  gif_key?: string | null;
  payload_key?: string | null;
  swf_key?: string | null;
  created_at: string;
  edited_at?: string | null;
  is_mine: boolean;
  sender: {
    username: string;
    display_name: string;
  };
}

export interface ConversationViewProps {
  conversationId: string;
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onBack: () => void;
  onMenu?: () => void;
}

export class ConversationView {
  private element: HTMLElement;
  private props: ConversationViewProps;
  private messages: Message[] = [];
  private loading = true;
  private sending = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nextCursor: string | null = null;
  private loadingMore = false;
  private hasMore = true;

  private selectedFile: File | null = null;
  private editingMsgId: string | null = null;
  private pendingEnrich: Promise<void>[] = [];

  constructor(props: ConversationViewProps) {
    this.props = props;
    this.element = this.createElement();
    this.loadConversation();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'conversation-view';

    // Header
    const header = document.createElement('div');
    header.className = 'chat-header conv-header';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'chat-header-menu';
    menuBtn.textContent = '≡';
    menuBtn.title = t('messages.menu');
    menuBtn.addEventListener('click', () => this.props.onMenu?.());

    const backBtn = document.createElement('button');
    backBtn.className = 'conv-header-back';
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => {
      this.stopPolling();
      this.props.onBack();
    });

    const titleWrap = document.createElement('div');
    titleWrap.className = 'chat-header-title';

    const userAvatar = document.createElement('div');
    userAvatar.id = 'conv-user-avatar';
    userAvatar.className = 'conv-header-avatar chat-header-icon';

    const userName = document.createElement('div');
    userName.id = 'conv-user-name';
    userName.className = 'conv-header-name chat-header-name';

    titleWrap.appendChild(userAvatar);
    titleWrap.appendChild(userName);

    header.appendChild(menuBtn);
    header.appendChild(backBtn);
    header.appendChild(titleWrap);

    // Messages area
    const messagesArea = document.createElement('div');
    messagesArea.id = 'conv-messages-area';
    messagesArea.className = 'chat-messages';
    messagesArea.addEventListener('scroll', () => {
      if (messagesArea.scrollTop < 100 && this.hasMore && !this.loadingMore) {
        this.loadOlderMessages();
      }
    });

    // Input area
    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';

    const fileBtn = document.createElement('button');
    fileBtn.id = 'conv-file-btn';
    fileBtn.className = 'chat-input-btn';
    fileBtn.textContent = '📎';
    fileBtn.title = t('composer.attach_file');
    fileBtn.addEventListener('click', () => fileInput.click());

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'conv-file-input';
    fileInput.style.display = 'none';
    fileInput.accept = '.gif,.jpg,.jpeg,.png,.webp,.mp3,.wav,.ogg,.m4a,.webm,.zip,.swf';
    fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleFileSelection(file);
    });

    const input = document.createElement('textarea');
    input.id = 'conv-message-input';
    input.className = 'conv-input chat-input';
    input.rows = 1;
    input.placeholder = t('messages.placeholder');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    input.addEventListener('input', () => {
      this.updateCharCount();
      this.autoGrow();
    });

    const sendBtn = document.createElement('button');
    sendBtn.id = 'conv-send-btn';
    sendBtn.className = 'chat-send-btn';
    sendBtn.title = t('messages.send');
    sendBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    sendBtn.addEventListener('click', () => this.sendMessage());

    const charCount = document.createElement('div');
    charCount.id = 'conv-char-count';
    charCount.className = 'conv-char-count chat-char-count';

    // File preview
    const filePreview = document.createElement('div');
    filePreview.id = 'conv-file-preview';
    filePreview.className = 'conv-file-preview chat-file-preview';
    filePreview.style.display = 'none';
    const filePreviewInfo = document.createElement('span');
    filePreviewInfo.className = 'conv-file-preview-info';
    const fileRemoveBtn = document.createElement('button');
    fileRemoveBtn.className = 'conv-file-preview-remove';
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

    container.appendChild(header);
    container.appendChild(messagesArea);
    container.appendChild(inputArea);

    return container;
  }

  private autoGrow(): void {
    const input = this.element.querySelector('#conv-message-input') as HTMLTextAreaElement;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  private updateCharCount(): void {
    const input = this.element.querySelector('#conv-message-input') as HTMLTextAreaElement;
    const count = this.element.querySelector('#conv-char-count') as HTMLElement;
    if (input && count) {
      count.textContent = `${input.value.length}/200`;
    }
  }

  private handleFileSelection(file: File): void {
    const maxSize = 25 * 1024 * 1024;
    if (file.size > maxSize) {
      showToast(t('composer.error_file_too_large'), true);
      return;
    }
    this.selectedFile = file;
    const preview = this.element.querySelector('#conv-file-preview') as HTMLElement;
    const info = this.element.querySelector('.conv-file-preview-info') as HTMLElement;
    if (preview && info) {
      info.textContent = file.name;
      preview.style.display = 'flex';
    }
  }

  private clearFileSelection(): void {
    this.selectedFile = null;
    const preview = this.element.querySelector('#conv-file-preview') as HTMLElement;
    const input = this.element.querySelector('#conv-file-input') as HTMLInputElement;
    if (preview) preview.style.display = 'none';
    if (input) input.value = '';
  }

  private async loadConversation(): Promise<void> {
    try {
      const res = await fetch(`/api/dm/conversations/${this.props.conversationId}`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as {
          id: string;
          other_user: { username: string; display_name: string; avatar_key: string | null };
        };

        const avatar = this.element.querySelector('#conv-user-avatar') as HTMLElement;
        const name = this.element.querySelector('#conv-user-name') as HTMLElement;
        if (avatar) {
          if (data.other_user.avatar_key) {
            avatar.style.backgroundImage = `url(/api/images/${data.other_user.avatar_key})`;
            avatar.style.backgroundSize = 'cover';
            avatar.textContent = '';
          } else {
            avatar.textContent = (data.other_user.display_name || data.other_user.username).charAt(0).toUpperCase();
          }
        }
        if (name) {
          name.textContent = data.other_user.display_name || data.other_user.username;
        }
      }
    } catch {
      // ignore
    }

    await this.fetchMessages(true);

    // Mark as read
    try {
      await fetch(`/api/dm/conversations/${this.props.conversationId}/read`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // ignore
    }

    // Start polling for new messages
    this.startPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.pollNewMessages();
    }, 3000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollNewMessages(): Promise<void> {
    if (this.messages.length === 0) return;
    const latestMsg = this.messages[this.messages.length - 1];
    try {
      const res = await fetch(
        `/api/dm/conversations/${this.props.conversationId}/messages?limit=10&cursor=${encodeURIComponent(latestMsg.created_at)}`,
        { credentials: 'include' },
      );
      if (res.ok) {
        const data = (await res.json()) as { messages: Message[]; next_cursor: string | null };
        if (data.messages.length > 0) {
          const existingIds = new Set(this.messages.map((m) => m.id));
          const newMsgs = data.messages.filter((m) => !existingIds.has(m.id)).reverse();
          if (newMsgs.length > 0) {
            this.messages.push(...newMsgs);
            this.renderMessages();
            this.scrollToBottom();

            // Mark as read
            try {
              await fetch(`/api/dm/conversations/${this.props.conversationId}/read`, {
                method: 'POST',
                credentials: 'include',
              });
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore polling errors
    }
  }

  private async fetchMessages(initial: boolean): Promise<void> {
    this.loading = initial;
    try {
      const cursorParam = this.nextCursor ? `&cursor=${encodeURIComponent(this.nextCursor)}` : '';
      const res = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages?limit=50${cursorParam}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { messages: Message[]; next_cursor: string | null };
        // API returns newest first, reverse for display
        const newMsgs = (data.messages || []).reverse();
        if (initial) {
          this.messages = newMsgs;
        } else {
          this.messages = [...newMsgs, ...this.messages];
        }
        this.nextCursor = data.next_cursor;
        this.hasMore = data.next_cursor !== null;

        this.loading = false;
        this.loadingMore = false;
        this.renderMessages();
        if (initial) {
          this.scrollToBottom();
        } else if (newMsgs.length > 0) {
          const firstMsgId = newMsgs[0].id;
          requestAnimationFrame(() => {
            const msgEl = this.element.querySelector(`[data-msg-id="${firstMsgId}"]`) as HTMLElement;
            if (msgEl) msgEl.scrollIntoView({ block: 'start' });
          });
        }
        return;
      }
    } catch {
      // ignore
    }
    this.loading = false;
    this.loadingMore = false;
    this.renderMessages();
    if (initial) {
      this.scrollToBottom();
    }
  }

  private async loadOlderMessages(): Promise<void> {
    if (this.loadingMore || !this.hasMore) return;
    this.loadingMore = true;
    await this.fetchMessages(false);
  }

  private startEdit(msg: Message): void {
    this.editingMsgId = msg.id;
    const input = this.element.querySelector('#conv-message-input') as HTMLTextAreaElement;
    const sendBtn = this.element.querySelector('#conv-send-btn') as HTMLButtonElement;
    if (input) {
      input.value = msg.content;
      input.focus();
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
    const input = this.element.querySelector('#conv-message-input') as HTMLTextAreaElement;
    const sendBtn = this.element.querySelector('#conv-send-btn') as HTMLButtonElement;
    if (input) input.value = '';
    if (sendBtn) {
      sendBtn.title = t('messages.send');
      sendBtn.classList.remove('chat-send-btn--edit');
    }
    this.updateCharCount();
    this.autoGrow();
  }

  private async sendMessage(): Promise<void> {
    const input = this.element.querySelector('#conv-message-input') as HTMLTextAreaElement;
    const sendBtn = this.element.querySelector('#conv-send-btn') as HTMLButtonElement;
    const content = input?.value?.trim();
    if ((!content && !this.selectedFile) || this.sending) return;

    this.sending = true;
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
      if (this.editingMsgId) {
        // Edit existing message
        const res = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages/${this.editingMsgId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ content }),
        });

        if (res.ok) {
          const updated = (await res.json()) as { id: string; content: string; edited_at: string };
          const idx = this.messages.findIndex((m) => m.id === updated.id);
          if (idx !== -1) {
            this.messages[idx].content = updated.content;
            this.messages[idx].edited_at = updated.edited_at;
          }
          this.renderMessages();
          this.cancelEdit();
        } else {
          const err = (await res.json()) as { error?: string };
          showToast(err.error || 'Edit failed', true);
        }
        this.sending = false;
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
        return;
      }

      // Send new message
      let gifKey: string | undefined;
      let payloadKey: string | undefined;
      let swfKey: string | undefined;
      let messageId: string | undefined;

      // Upload file if selected
      if (this.selectedFile) {
        const prepareRes = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ filename: this.selectedFile.name }),
        });

        if (!prepareRes.ok) {
          const err = (await prepareRes.json()) as { error?: string };
          showToast(err.error || 'Failed to prepare upload', true);
          throw new Error('Prepare failed');
        }

        const prepareData = (await prepareRes.json()) as {
          msgId: string;
          uploadUrl: string;
          storageKey: string;
          gifKey?: string;
          payloadKey?: string;
          swfKey?: string;
        };

        messageId = prepareData.msgId;
        gifKey = prepareData.gifKey;
        payloadKey = prepareData.payloadKey;
        swfKey = prepareData.swfKey;

        // Upload file
        const uploadRes = await fetch(prepareData.uploadUrl, {
          method: 'PUT',
          body: this.selectedFile,
          credentials: 'include',
        });

        if (!uploadRes.ok) {
          showToast('Failed to upload file', true);
          throw new Error('Upload failed');
        }
      }

      // Send message
      const body: Record<string, unknown> = {};
      if (content) body.content = content;
      if (gifKey) body.gifKey = gifKey;
      if (payloadKey) body.payloadKey = payloadKey;
      if (swfKey) body.swfKey = swfKey;
      if (messageId) body.messageId = messageId;

      const res = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const msg = (await res.json()) as Message;
        this.messages.push(msg);
        this.renderMessages();
        this.scrollToBottom();
        input.value = '';
        this.clearFileSelection();
        this.updateCharCount();
        this.autoGrow();
      } else {
        const err = (await res.json()) as { error?: string };
        console.error('Send failed:', err.error);
        showToast(err.error || 'Send failed', true);
      }
    } catch {
      console.error('Send failed');
    }

    this.sending = false;
    sendBtn.disabled = false;
    sendBtn.style.opacity = '1';
  }

  private renderMessages(): void {
    const area = this.element.querySelector('#conv-messages-area') as HTMLElement;
    if (!area) return;
    area.innerHTML = '';
    this.pendingEnrich = [];

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
      empty.textContent = t('messages.empty');
      area.appendChild(empty);
      return;
    }

    // Load more indicator at top
    if (this.hasMore) {
      const loadMore = document.createElement('div');
      loadMore.className = 'chat-load-more';
      loadMore.textContent = this.loadingMore ? t('common.loading') : '';
      area.appendChild(loadMore);
    }

    let prevMsg: Message | null = null;
    let prevDay = '';

    this.messages.forEach((msg) => {
      const day = new Date(msg.created_at).toDateString();

      // Date separator
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

      // Avatar (hidden on grouped continuation)
      const avatar = document.createElement('div');
      avatar.className = 'msg-row-avatar';
      if (!grouped) {
        avatar.textContent = (msg.sender.display_name || msg.sender.username).charAt(0).toUpperCase();
      }

      const content = document.createElement('div');
      content.className = 'msg-row-content';

      if (!grouped) {
        const head = document.createElement('div');
        head.className = 'msg-row-head';

        const username = document.createElement('span');
        username.className = 'msg-row-username';
        username.textContent = msg.sender.display_name || msg.sender.username;

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

      // Attachment rendering
      if (msg.gif_key || msg.payload_key || msg.swf_key) {
        const attachment = document.createElement('div');
        attachment.className = 'conv-bubble-attachment';
        this.renderAttachment(attachment, msg);
        body.appendChild(attachment);
      }

      // Text content
      if (msg.content) {
        const text = document.createElement('div');
        text.className = 'msg-row-text';
        text.textContent = msg.content;
        body.appendChild(text);
        this.pendingEnrich.push(this.enrichText(text, msg.content));

        const previewContainer = document.createElement('div');
        previewContainer.className = 'post-link-preview-container';
        previewContainer.style.cssText = 'overflow: hidden;';
        body.appendChild(previewContainer);
        loadLinkPreview(msg.content, previewContainer);
      }

      content.appendChild(body);

      // Hover actions (edit/delete for own messages)
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
        deleteBtn.addEventListener('click', () => this.confirmDelete(msg));

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        content.appendChild(actions);
      }

      row.appendChild(avatar);
      row.appendChild(content);
      area.appendChild(row);

      prevMsg = msg;
    });
  }

  private shouldGroup(prev: Message | null, curr: Message): boolean {
    if (!prev) return false;
    if (prev.sender_id !== curr.sender_id) return false;
    if (prev.is_mine !== curr.is_mine) return false;
    const prevDate = new Date(prev.created_at);
    const currDate = new Date(curr.created_at);
    if (prevDate.toDateString() !== currDate.toDateString()) return false;
    const diff = currDate.getTime() - prevDate.getTime();
    return diff >= 0 && diff <= 5 * 60 * 1000;
  }

  private async enrichText(el: HTMLElement, content: string): Promise<void> {
    try {
      const html = await processText(content);
      el.innerHTML = html;
      linkifyUrls(el);
      linkifyHashtags(el);
    } catch (err) {
      console.error('Failed to enrich message text:', err);
    }
  }

  private renderAttachment(container: HTMLElement, msg: Message): void {
    const gifKey = msg.gif_key;
    const payloadKey = msg.payload_key;
    const swfKey = msg.swf_key;

    if (gifKey && gifKey.startsWith('dm/audio/')) {
      const player = createAudioPlayer({
        gifKey,
        postId: msg.id,
      });
      player.style.maxWidth = '300px';
      container.appendChild(player);
    } else if (gifKey && gifKey.startsWith('dm/video/')) {
      const player = createVideoPlayer({
        gifKey,
        postId: msg.id,
      });
      player.style.maxWidth = '100%';
      container.appendChild(player);
    } else if (gifKey && gifKey.startsWith('dm/gif/')) {
      const preview = createImagePreview({
        gifKey,
        postId: msg.id,
      });
      preview.style.maxWidth = '100%';
      container.appendChild(preview);
    } else if (payloadKey && (payloadKey.startsWith('dm/zip/') || payloadKey.startsWith('dm/html/'))) {
      this.renderZipAttachment(container, msg);
    } else if (swfKey && swfKey.startsWith('dm/swf/')) {
      this.renderSwfAttachment(container, msg);
    }
  }

  private renderZipAttachment(container: HTMLElement, msg: Message): void {
    const btn = document.createElement('div');
    btn.className = 'execution-button';
    btn.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 16px 24px; cursor: pointer;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; border-radius: 12px; font-weight: 600; font-size: 15px;
      max-width: 300px; transition: all 0.2s ease;
    `;
    btn.innerHTML = '<span style="font-size:24px">📦</span> ' + t('messages.open_zip');
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.02)';
      btn.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', () => this.executeZipModal(msg));
    container.appendChild(btn);
  }

  private renderSwfAttachment(container: HTMLElement, msg: Message): void {
    const btn = document.createElement('div');
    btn.className = 'execution-button';
    btn.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 16px 24px; cursor: pointer;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; border-radius: 12px; font-weight: 600; font-size: 15px;
      max-width: 300px; transition: all 0.2s ease;
    `;
    btn.innerHTML = '<span style="font-size:24px">⚡</span> ' + t('messages.play_flash');
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.02)';
      btn.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', () => this.executeSwfModal(msg));
    container.appendChild(btn);
  }

  private executeZipModal(msg: Message): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85); display: flex;
      align-items: center; justify-content: center; z-index: 9999;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      width: 90%; max-width: 800px; height: 80vh;
      background: var(--bg-primary); border-radius: 12px; overflow: hidden;
      position: relative; display: flex; flex-direction: column;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 16px; background: var(--bg-tertiary);
    `;

    const title = document.createElement('span');
    title.style.cssText = 'font-weight: 600; font-size: 14px; color: var(--text-primary);';
    title.textContent = t('messages.open_zip');

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background: none; border: none; font-size: 18px; cursor: pointer;
      color: var(--text-muted); padding: 4px 8px;
    `;
    closeBtn.addEventListener('click', () => {
      destroy();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.style.cssText = 'flex: 1; position: relative; background: var(--bg-primary);';

    modal.appendChild(header);
    modal.appendChild(content);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const destroy = () => {
      unregister();
      overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy();
    });

    // Execute ZIP in the modal content (force legacy mode — sandbox WVFS doesn't support DM-prefixed keys)
    executeZipAuto(msg.id, content).catch((err) => {
      console.error('ZIP execution failed:', err);
      content.innerHTML =
        '<div style="padding: 40px; text-align: center; color: var(--text-muted);">' +
        t('post_stage.zip_load_error') +
        '</div>';
    });
  }

  private executeSwfModal(msg: Message): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85); display: flex;
      align-items: center; justify-content: center; z-index: 9999;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      width: 90%; max-width: 800px; height: 80vh;
      background: var(--bg-primary); border-radius: 12px; overflow: hidden;
      position: relative; display: flex; flex-direction: column;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 16px; background: var(--bg-tertiary);
    `;

    const title = document.createElement('span');
    title.style.cssText = 'font-weight: 600; font-size: 14px; color: var(--text-primary);';
    title.textContent = t('messages.play_flash');

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background: none; border: none; font-size: 18px; cursor: pointer;
      color: var(--text-muted); padding: 4px 8px;
    `;
    closeBtn.addEventListener('click', () => {
      destroy();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.style.cssText =
      'flex: 1; position: relative; background: #000; display: flex; align-items: center; justify-content: center;';

    modal.appendChild(header);
    modal.appendChild(content);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const destroy = () => {
      unregister();
      overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy();
    });

    // Execute Flash in the modal content
    executeFlash(msg.id, content).catch((err) => {
      console.error('Flash execution failed:', err);
      content.innerHTML =
        '<div style="padding: 40px; text-align: center; color: var(--text-muted);">' +
        t('post_stage.flash_load_error') +
        '</div>';
    });
  }

  private confirmDelete(msg: Message): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); display: flex;
      align-items: center; justify-content: center; z-index: 1000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-primary); border: 1px solid var(--border);
      border-radius: 8px; padding: 24px; max-width: 400px; width: 90%;
    `;

    const title = document.createElement('h3');
    title.style.cssText = 'margin: 0 0 16px 0; font-size: 18px; color: var(--text-primary);';
    title.textContent = t('messages.delete_title');

    const message = document.createElement('p');
    message.style.cssText = 'margin: 0 0 24px 0; color: var(--text-muted); font-size: 14px;';
    message.textContent = t('messages.delete_message');

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('common.cancel');
    cancelBtn.style.cssText =
      'padding: 8px 16px; background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); cursor: pointer;';

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = t('common.delete');
    deleteBtn.style.cssText =
      'padding: 8px 16px; background: var(--danger, #e74c3c); border: none; border-radius: 4px; color: #fff; cursor: pointer;';

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(deleteBtn);
    dialog.appendChild(title);
    dialog.appendChild(message);
    dialog.appendChild(buttonRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const destroy = () => {
      unregister();
      overlay.remove();
    };

    cancelBtn.addEventListener('click', destroy);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy();
    });

    deleteBtn.addEventListener('click', async () => {
      destroy();
      try {
        const res = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages/${msg.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (res.ok) {
          this.messages = this.messages.filter((m) => m.id !== msg.id);
          this.renderMessages();
        } else {
          const err = (await res.json()) as { error?: string };
          showToast(err.error || 'Delete failed', true);
        }
      } catch {
        showToast('Delete failed', true);
      }
    });
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
    const date = new Date(createdAt);
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  private scrollToBottom(): void {
    const area = this.element.querySelector('#conv-messages-area') as HTMLElement;
    if (!area) return;
    Promise.allSettled(this.pendingEnrich).then(() => {
      if (!this.element.isConnected) return;
      this.stabilizeScroll(area, 0);
      setTimeout(() => {
        if (this.element.isConnected) area.scrollTop = area.scrollHeight;
      }, 300);
      setTimeout(() => {
        if (this.element.isConnected) area.scrollTop = area.scrollHeight;
      }, 1000);
    });
  }

  private stabilizeScroll(area: HTMLElement, attempts: number): void {
    if (!this.element.isConnected || attempts > 30) return;
    if (area.scrollTop !== area.scrollHeight) {
      area.scrollTop = area.scrollHeight;
      requestAnimationFrame(() => this.stabilizeScroll(area, attempts + 1));
    }
  }

  public focusInput(): void {
    const input = this.element.querySelector('#conv-message-input') as HTMLTextAreaElement;
    if (input) setTimeout(() => input.focus(), 100);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.stopPolling();
    this.element.remove();
  }
}

export function createConversationView(props: ConversationViewProps): ConversationView {
  return new ConversationView(props);
}
