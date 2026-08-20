import { t } from '../lib/i18n.js';

export interface ServerSummary {
  id: string;
  name: string;
  icon_key?: string | null;
  unread_count?: number;
  my_role?: string;
}

export interface ServerRailOptions {
  servers: ServerSummary[];
  activeServerId?: string | null;
  homeActive: boolean;
  onSelectHome: () => void;
  onSelectServer: (id: string) => void;
  onAddServer: () => void;
}

export function createServerRail(opts: ServerRailOptions): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'chat-server-panel server-rail';

  const section = document.createElement('div');
  section.className = 'chat-server-section';

  // Home / messages button
  const homeBtn = document.createElement('div');
  homeBtn.className = 'chat-server-item' + (opts.homeActive ? ' active' : '');
  homeBtn.textContent = '💬';
  homeBtn.title = t('servers.home');
  homeBtn.addEventListener('click', () => opts.onSelectHome());
  section.appendChild(homeBtn);

  // Server pills with unread badges
  for (const server of opts.servers) {
    const item = document.createElement('div');
    item.className = 'chat-server-item' + (opts.activeServerId === server.id ? ' active' : '');
    item.title = server.name;

    if (server.icon_key) {
      const img = document.createElement('img');
      img.className = 'chat-server-icon-img';
      img.loading = 'lazy';
      img.src = `/api/images/${server.icon_key}`;
      img.alt = server.name;
      img.addEventListener('error', () => {
        img.remove();
        item.textContent = server.name.charAt(0).toUpperCase();
      });
      img.addEventListener('click', () => opts.onSelectServer(server.id));
      item.appendChild(img);
    } else {
      item.textContent = server.name.charAt(0).toUpperCase();
    }

    if (!server.icon_key) {
      item.addEventListener('click', () => opts.onSelectServer(server.id));
    }

    const unread = Number(server.unread_count) || 0;
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'chat-server-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      item.appendChild(badge);
    }

    section.appendChild(item);
  }

  // Add server button
  const addBtn = document.createElement('div');
  addBtn.className = 'chat-server-item chat-server-add';
  addBtn.textContent = '+';
  addBtn.title = t('servers.create');
  addBtn.addEventListener('click', () => opts.onAddServer());
  section.appendChild(addBtn);

  panel.appendChild(section);
  return panel;
}

export function serverIconUrl(server: ServerSummary): string {
  if (!server.icon_key) return '';
  return `/api/images/${server.icon_key}`;
}
