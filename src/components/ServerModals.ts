import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';
import { showToast } from '../lib/toast.js';

export function createModalBase(className = 'chat-modal'): {
  overlay: HTMLElement;
  dialog: HTMLElement;
  close: () => void;
} {
  const unregister = registerModal();
  const overlay = document.createElement('div');
  overlay.className = className + '-overlay';
  const dialog = document.createElement('div');
  dialog.className = className + '-dialog';
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = () => {
    unregister();
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return { overlay, dialog, close };
}

function modalButton(text: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = className;
  btn.textContent = text;
  return btn;
}

export function showConfirmModal(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void | Promise<void>,
  danger = true,
): void {
  const { dialog, close } = createModalBase('chat-modal');
  const header = document.createElement('h3');
  header.className = 'chat-modal-title';
  header.textContent = title;

  const body = document.createElement('p');
  body.className = 'chat-modal-body';
  body.textContent = message;

  const row = document.createElement('div');
  row.className = 'chat-modal-row';

  const cancel = modalButton(t('common.cancel'), 'chat-btn chat-btn--ghost');
  cancel.addEventListener('click', close);

  const confirm = modalButton(confirmLabel, danger ? 'chat-btn chat-btn--danger' : 'chat-btn chat-btn--primary');
  confirm.addEventListener('click', async () => {
    try {
      await onConfirm();
    } finally {
      close();
    }
  });

  row.appendChild(cancel);
  row.appendChild(confirm);
  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(row);
}

export interface ServerCreateResult {
  id: string;
  name: string;
}

export function showServerCreateModal(onCreated: (server: ServerCreateResult) => void): void {
  const { dialog, close } = createModalBase('chat-modal');
  const header = document.createElement('h3');
  header.className = 'chat-modal-title';
  header.textContent = t('servers.create');

  const form = document.createElement('form');
  form.className = 'chat-modal-form';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'chat-modal-input';
  nameInput.placeholder = t('servers.name_placeholder');
  nameInput.maxLength = 80;
  nameInput.required = true;

  const descInput = document.createElement('textarea');
  descInput.className = 'chat-modal-textarea';
  descInput.placeholder = t('servers.description_placeholder');
  descInput.maxLength = 500;
  descInput.rows = 3;

  const iconInput = document.createElement('input');
  iconInput.type = 'file';
  iconInput.accept = 'image/*';
  iconInput.style.display = 'none';

  const iconBtn = modalButton(t('servers.upload_icon'), 'chat-btn chat-btn--ghost');
  const iconLabel = document.createElement('span');
  iconLabel.className = 'chat-modal-hint';
  iconBtn.addEventListener('click', () => iconInput.click());
  iconInput.addEventListener('change', () => {
    const file = iconInput.files?.[0];
    if (file) iconLabel.textContent = file.name;
  });

  const row = document.createElement('div');
  row.className = 'chat-modal-row';
  const cancel = modalButton(t('common.cancel'), 'chat-btn chat-btn--ghost');
  cancel.addEventListener('click', close);
  const submit = modalButton(t('servers.create_submit'), 'chat-btn chat-btn--primary');
  submit.type = 'submit';

  row.appendChild(cancel);
  row.appendChild(submit);
  form.appendChild(nameInput);
  form.appendChild(descInput);
  form.appendChild(iconBtn);
  form.appendChild(iconLabel);
  form.appendChild(row);
  dialog.appendChild(header);
  dialog.appendChild(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    submit.disabled = true;
    submit.textContent = t('common.loading');

    let iconKey: string | null = null;
    const file = iconInput.files?.[0];
    if (file) {
      try {
        const res = await fetch('/api/servers/icon', { method: 'PUT', body: file, credentials: 'include' });
        if (res.ok) {
          const data = (await res.json()) as { iconKey?: string };
          iconKey = data.iconKey || null;
        } else {
          const err = (await res.json()) as { error?: string };
          showToast(err.error || t('servers.icon_upload_failed'), true);
        }
      } catch {
        showToast(t('servers.icon_upload_failed'), true);
      }
    }

    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, description: descInput.value.trim(), iconKey }),
      });
      if (res.ok) {
        const data = (await res.json()) as { id: string };
        close();
        onCreated({ id: data.id, name });
      } else {
        const err = (await res.json()) as { error?: string };
        showToast(err.error || t('servers.create_failed'), true);
      }
    } catch {
      showToast(t('servers.create_failed'), true);
    } finally {
      submit.disabled = false;
      submit.textContent = t('servers.create_submit');
    }
  });

  setTimeout(() => nameInput.focus(), 50);
}

export interface UserSearchSuggestion {
  id: string;
  username: string;
  display_name: string;
}

export async function searchUsers(query: string): Promise<UserSearchSuggestion[]> {
  if (query.trim().length < 1) return [];
  try {
    const res = await fetch(`/api/users/suggest?q=${encodeURIComponent(query.trim())}`, { credentials: 'include' });
    if (!res.ok) return [];
    const data = (await res.json()) as { users: UserSearchSuggestion[] };
    return data.users || [];
  } catch {
    return [];
  }
}

export function showUserPickerModal(
  title: string,
  opts: {
    excludeIds: Set<string>;
    onPick: (user: UserSearchSuggestion) => void | Promise<void>;
  },
): void {
  const { dialog, close } = createModalBase('chat-modal');
  const header = document.createElement('h3');
  header.className = 'chat-modal-title';
  header.textContent = title;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-modal-input';
  input.placeholder = t('servers.search_users');

  const results = document.createElement('div');
  results.className = 'chat-modal-results';

  let timer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const users = await searchUsers(input.value);
      results.innerHTML = '';
      for (const user of users) {
        if (opts.excludeIds.has(user.id)) continue;
        const row = document.createElement('div');
        row.className = 'chat-modal-result';
        row.textContent = `${user.display_name || user.username} (@${user.username})`;
        row.addEventListener('click', async () => {
          await opts.onPick(user);
          close();
        });
        results.appendChild(row);
      }
    }, 250);
  });

  dialog.appendChild(header);
  dialog.appendChild(input);
  dialog.appendChild(results);
  setTimeout(() => input.focus(), 50);
}
