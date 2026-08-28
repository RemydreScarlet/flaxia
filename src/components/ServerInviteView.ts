import { t } from '../lib/i18n.js';
import { showToast } from '../lib/toast.js';

export interface ServerInviteProps {
  token: string;
  onJoin: (serverId: string) => void;
  onLogin: () => void;
}

interface InviteMeta {
  token: string;
  serverName: string;
  serverIconKey: string | null;
  serverDescription: string;
  role: string;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  expired: boolean;
  usedUp: boolean;
}

export class ServerInviteView {
  private readonly props: ServerInviteProps;
  private readonly element: HTMLElement;
  private destroyed = false;

  constructor(props: ServerInviteProps) {
    this.props = props;
    this.element = document.createElement('div');
    this.element.className = 'server-invite-view';
    this.element.innerHTML = `<div class="server-invite-card"><div class="server-invite-loading">…</div></div>`;
    void this.load();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.destroyed = true;
  }

  private async load(): Promise<void> {
    const res = await fetch(`/api/servers/invite/${this.props.token}`, { credentials: 'include' });
    if (this.destroyed) return;
    const card = this.element.querySelector('.server-invite-card') as HTMLElement;
    if (!res.ok) {
      card.innerHTML = `<div class="server-invite-message">${t('servers.invite_not_found') || 'Invite not found'}</div>`;
      return;
    }
    const meta = (await res.json()) as InviteMeta;
    this.render(card, meta);
  }

  private async render(card: HTMLElement, meta: InviteMeta): Promise<void> {
    const me = await fetch('/api/me', { credentials: 'include' });
    const authed = me.ok;

    card.innerHTML = '';
    const title = document.createElement('h2');
    title.className = 'server-invite-title';
    title.textContent = (t('servers.invite_join_title') || 'You are invited to') + ' ' + meta.serverName;
    card.appendChild(title);

    if (meta.serverDescription) {
      const desc = document.createElement('p');
      desc.className = 'server-invite-desc';
      desc.textContent = meta.serverDescription;
      card.appendChild(desc);
    }

    const roleLine = document.createElement('div');
    roleLine.className = 'server-invite-role';
    roleLine.textContent =
      (t('servers.invite_role') || 'You will join as') + ' ' + (meta.role === 'admin' ? 'admin' : 'member');
    card.appendChild(roleLine);

    if (meta.expired || meta.usedUp) {
      const msg = document.createElement('div');
      msg.className = 'server-invite-message';
      msg.textContent = t('servers.invite_invalid') || 'This invite is no longer valid';
      card.appendChild(msg);
      return;
    }

    const btn = document.createElement('button');
    btn.className = 'chat-btn chat-btn--primary server-invite-btn';
    if (!authed) {
      btn.textContent = t('servers.invite_login_to_join') || 'Log in to join';
      btn.addEventListener('click', () => this.props.onLogin());
    } else {
      btn.textContent = t('servers.invite_join') || 'Join server';
      btn.addEventListener('click', () => void this.join());
    }
    card.appendChild(btn);
  }

  private async join(): Promise<void> {
    const res = await fetch(`/api/servers/invite/${this.props.token}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      showToast(err.error || t('servers.invite_join_failed') || 'Failed to join', true);
      return;
    }
    const data = (await res.json()) as { serverId: string };
    this.props.onJoin(data.serverId);
  }
}
