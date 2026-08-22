import { t } from '../lib/i18n.js';
import { unlockIdentityFromSession } from '../lib/messenger-store.js';
import { registerModal } from '../lib/modal-state.js';
import { showToast } from '../lib/toast.js';
import { GroupTransport } from './chat/group.js';
import { MessageView } from './chat/MessageView.js';

export interface GroupMember {
  id: string;
  username: string;
  display_name: string;
  avatar_key: string | null;
  role: string;
  joined_at: string;
}

export interface GroupChatViewProps {
  groupId: string;
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onBack: () => void;
  onMenu?: () => void;
}

export class GroupChatView extends MessageView {
  private readonly props: GroupChatViewProps;
  private readonly group: GroupTransport;
  private groupName = '';
  private myRole = '';
  private members: GroupMember[] = [];

  constructor(props: GroupChatViewProps) {
    super('group');
    this.props = props;
    this.group = new GroupTransport(props.groupId);
    this.transport = this.group;
    this.element = this.createElement();
    void this.load();
  }

  protected override emptyStateText(): string {
    return t('groups.empty');
  }

  protected override inputPlaceholder(): string {
    return t('groups.placeholder');
  }

  private async load(): Promise<void> {
    await this.unlockIdentity();
    await this.loadGroup();
  }

  private async unlockIdentity(): Promise<boolean> {
    try {
      return await unlockIdentityFromSession();
    } catch {
      return false;
    }
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'group-chat-view';

    const main = document.createElement('div');
    main.className = 'group-chat-main';

    const header = document.createElement('div');
    header.className = 'group-chat-header chat-header';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'chat-header-menu';
    menuBtn.textContent = '≡';
    menuBtn.title = t('messages.menu');
    menuBtn.addEventListener('click', () => this.props.onMenu?.());

    const backBtn = document.createElement('button');
    backBtn.className = 'group-chat-header-back';
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => {
      this.stopPolling();
      this.props.onBack();
    });

    const groupAvatar = document.createElement('div');
    groupAvatar.id = 'group-chat-avatar';
    groupAvatar.className = 'group-chat-header-avatar chat-header-icon';

    const groupInfo = document.createElement('div');
    groupInfo.className = 'group-chat-header-info chat-header-title';

    const groupName = document.createElement('div');
    groupName.id = 'group-chat-name';
    groupName.className = 'group-chat-header-name chat-header-name';

    const groupMeta = document.createElement('div');
    groupMeta.id = 'group-chat-meta';
    groupMeta.className = 'group-chat-header-meta chat-header-meta';

    groupInfo.appendChild(groupName);
    groupInfo.appendChild(groupMeta);

    const callBtn = document.createElement('button');
    callBtn.className = 'group-call-btn chat-header-call';
    callBtn.title = t('calls.voice');
    callBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    callBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('startGroupCall', { detail: { groupId: this.props.groupId } }));
    });

    const membersBtn = document.createElement('button');
    membersBtn.className = 'group-chat-members-btn';
    membersBtn.textContent = t('groups.members');
    membersBtn.addEventListener('click', () => this.showMembersModal());

    header.appendChild(menuBtn);
    header.appendChild(backBtn);
    header.appendChild(groupAvatar);
    header.appendChild(groupInfo);
    header.appendChild(callBtn);
    header.appendChild(membersBtn);

    main.appendChild(header);
    main.appendChild(this.buildMessagesArea());
    main.appendChild(this.buildComposer());

    container.appendChild(main);
    container.appendChild(this.createMemberPanel());
    return container;
  }

  private createMemberPanel(): HTMLElement {
    const panel = document.createElement('aside');
    panel.className = 'group-member-panel';
    panel.id = 'group-member-panel';
    const title = document.createElement('div');
    title.className = 'group-member-panel-title';
    title.textContent = t('groups.members').toUpperCase();
    panel.appendChild(title);
    return panel;
  }

  private renderMemberPanel(): void {
    const panel = this.element.querySelector('#group-member-panel') as HTMLElement;
    if (!panel) return;
    Array.from(panel.querySelectorAll(':scope > .group-member-row')).forEach((el) => {
      el.remove();
    });
    this.members.forEach((member) => {
      const row = document.createElement('div');
      row.className = 'group-member-row';
      const avatar = document.createElement('div');
      avatar.className = 'group-member-row-avatar';
      if (member.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${member.avatar_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else {
        avatar.textContent = (member.display_name || member.username).charAt(0).toUpperCase();
      }
      const info = document.createElement('div');
      info.className = 'group-member-row-info';
      const name = document.createElement('div');
      name.className = 'group-member-row-name';
      name.textContent = member.display_name || member.username;
      info.appendChild(name);
      row.appendChild(avatar);
      row.appendChild(info);
      if (member.role === 'owner') {
        const role = document.createElement('span');
        role.className = 'group-member-row-role';
        role.textContent = '👑';
        row.appendChild(role);
      }
      panel.appendChild(row);
    });
  }

  private async loadGroup(): Promise<void> {
    try {
      const res = await fetch(`/api/groups/${this.props.groupId}`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as {
          id: string;
          name: string;
          description: string;
          icon_key: string | null;
          key_version?: number;
          my_role: string;
          members: GroupMember[];
        };
        this.groupName = data.name;
        this.myRole = data.my_role;
        this.members = data.members || [];
        await this.group.setKeyVersion(data.key_version || 1);

        const avatar = this.element.querySelector('#group-chat-avatar') as HTMLElement;
        const name = this.element.querySelector('#group-chat-name') as HTMLElement;
        const meta = this.element.querySelector('#group-chat-meta') as HTMLElement;
        if (avatar) {
          if (data.icon_key) {
            avatar.style.backgroundImage = `url(/api/images/${data.icon_key})`;
            avatar.style.backgroundSize = 'cover';
            avatar.textContent = '';
          } else {
            avatar.textContent = data.name.charAt(0).toUpperCase();
          }
        }
        if (name) name.textContent = data.name;
        if (meta) meta.textContent = `${data.members.length} ${t('groups.members')}`;
        this.renderMemberPanel();
      }
    } catch {
      /* ignore */
    }
    await this.fetchMessages(true);
    void this.markRead();
    this.startPolling();
  }

  private showMembersModal(): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';

    const dialog = document.createElement('div');
    dialog.style.cssText =
      'background: var(--bg-primary); border: 1px solid var(--border); border-radius: 12px; padding: 24px; max-width: 400px; width: 90%; max-height: 80vh; display: flex; flex-direction: column;';

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;';

    const title = document.createElement('h3');
    title.style.cssText = 'margin: 0; font-size: 18px; color: var(--text-primary);';
    title.textContent = `${this.groupName} - ${t('groups.members')}`;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background: none; border: none; font-size: 18px; cursor: pointer; color: var(--text-muted); padding: 4px;';
    closeBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    const canManage = this.myRole === 'owner' || this.myRole === 'admin';
    const addSection = document.createElement('div');
    if (canManage) {
      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.placeholder = t('groups.search_users');
      addInput.style.cssText =
        'width: 100%; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); color: var(--text-primary); font-size: 13px; font-family: inherit; outline: none; box-sizing: border-box; margin-bottom: 8px;';

      const addResults = document.createElement('div');
      addResults.id = 'group-add-member-results';
      addResults.style.cssText = 'max-height: 150px; overflow-y: auto; margin-bottom: 8px;';

      let addTimer: ReturnType<typeof setTimeout> | null = null;
      addInput.addEventListener('input', () => {
        if (addTimer) clearTimeout(addTimer);
        addTimer = setTimeout(async () => {
          const q = addInput.value.trim();
          if (q.length < 1) {
            addResults.innerHTML = '';
            return;
          }
          try {
            const res = await fetch(`/api/users/suggest?q=${encodeURIComponent(q)}`, { credentials: 'include' });
            if (res.ok) {
              const data = (await res.json()) as {
                users: Array<{ id: string; username: string; display_name: string }>;
              };
              const existingIds = new Set(this.members.map((m) => m.id));
              addResults.innerHTML = '';
              (data.users || [])
                .filter((u) => !existingIds.has(u.id) && u.id !== this.props.currentUser?.id)
                .forEach((u) => {
                  const row = document.createElement('div');
                  row.style.cssText =
                    'padding: 8px; cursor: pointer; border-radius: 6px; display: flex; align-items: center; gap: 8px; font-size: 13px;';
                  row.addEventListener('mouseenter', () => (row.style.background = 'var(--bg-secondary)'));
                  row.addEventListener('mouseleave', () => (row.style.background = ''));
                  row.textContent = `${u.display_name || u.username} (@${u.username})`;
                  row.addEventListener('click', async () => {
                    try {
                      const r = await fetch(`/api/groups/${this.props.groupId}/members`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ memberIds: [u.id] }),
                      });
                      if (r.ok) {
                        showToast(t('groups.member_added'));
                        addResults.innerHTML = '';
                        addInput.value = '';
                        void this.loadGroup();
                      }
                    } catch {
                      /* ignore */
                    }
                  });
                  addResults.appendChild(row);
                });
            }
          } catch {
            /* ignore */
          }
        }, 300);
      });
      addSection.appendChild(addInput);
      addSection.appendChild(addResults);
    }

    const memberList = document.createElement('div');
    memberList.style.cssText = 'overflow-y: auto; flex: 1;';

    this.members.forEach((member) => {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-radius: 6px;';

      const avatar = document.createElement('div');
      avatar.style.cssText =
        'width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; background: var(--accent); display: flex; align-items: center; justify-content: center; color: #000; font-weight: 600; font-size: 14px; overflow: hidden;';
      if (member.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${member.avatar_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else {
        avatar.textContent = (member.display_name || member.username).charAt(0).toUpperCase();
      }

      const info = document.createElement('div');
      info.style.cssText = 'flex: 1; min-width: 0;';
      const name = document.createElement('div');
      name.style.cssText = 'color: var(--text-primary); font-weight: 500; font-size: 14px;';
      name.textContent = member.display_name || member.username;
      const role = document.createElement('span');
      role.style.cssText = 'color: var(--text-muted); font-size: 11px; margin-left: 6px;';
      role.textContent = member.role === 'owner' ? '👑' : member.role === 'admin' ? '🔧' : '';
      const handle = document.createElement('div');
      handle.style.cssText = 'color: var(--text-muted); font-size: 12px;';
      handle.textContent = `@${member.username}`;
      name.appendChild(role);
      info.appendChild(name);
      info.appendChild(handle);

      row.appendChild(avatar);
      row.appendChild(info);

      if (canManage && member.id !== this.props.currentUser?.id && member.role !== 'owner') {
        const removeBtn = document.createElement('button');
        removeBtn.textContent = t('common.delete');
        removeBtn.style.cssText =
          'padding: 4px 8px; font-size: 11px; background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-muted); cursor: pointer;';
        removeBtn.addEventListener('click', async () => {
          try {
            const r = await fetch(`/api/groups/${this.props.groupId}/members/${member.id}`, {
              method: 'DELETE',
              credentials: 'include',
            });
            if (r.ok) {
              showToast(t('groups.member_removed'));
              void this.loadGroup();
            }
          } catch {
            /* ignore */
          }
        });
        row.appendChild(removeBtn);
      }

      if (member.id === this.props.currentUser?.id && member.role !== 'owner') {
        const leaveBtn = document.createElement('button');
        leaveBtn.textContent = t('groups.leave');
        leaveBtn.style.cssText =
          'padding: 4px 8px; font-size: 11px; background: none; border: 1px solid var(--danger, #e74c3c); border-radius: 4px; color: var(--danger, #e74c3c); cursor: pointer;';
        leaveBtn.addEventListener('click', async () => {
          try {
            const r = await fetch(`/api/groups/${this.props.groupId}/members/${member.id}`, {
              method: 'DELETE',
              credentials: 'include',
            });
            if (r.ok) {
              unregister();
              overlay.remove();
              this.props.onBack();
            }
          } catch {
            /* ignore */
          }
        });
        row.appendChild(leaveBtn);
      }

      memberList.appendChild(row);
    });

    dialog.appendChild(header);
    dialog.appendChild(addSection);
    dialog.appendChild(memberList);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
  }
}

export function createGroupChatView(props: GroupChatViewProps): GroupChatView {
  return new GroupChatView(props);
}
