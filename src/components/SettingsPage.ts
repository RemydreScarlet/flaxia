import { clearMeCache } from '../lib/auth-cache';
import { storeSrpSalt } from '../lib/auth-srp.js';
import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { getLocale, setLocale, t } from '../lib/i18n.js';
import { rewrapE2EEIdentityV2, unlockIdentityV2WithPassword } from '../lib/messenger-identity-v2.js';
import { getReplyStyle, getShowNsfw, ReplyStyle, setReplyStyle, setShowNsfw } from '../lib/settings.js';
import { clientStep1, clientStep2, computeVerifier, generateSalt } from '../lib/srp.js';
import { getTheme, setTheme, Theme } from '../lib/theme.js';

function b64(b: Uint8Array): string {
  let binary = '';
  for (const x of b) binary += String.fromCharCode(x);
  return btoa(binary);
}

function unb64(s: string): Uint8Array {
  const binary = atob(s);
  const b = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) b[i] = binary.charCodeAt(i);
  return b;
}

interface SettingsPageProps {
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    language?: string;
    email?: string;
  };
}

export function createSettingsPage({ currentUser }: SettingsPageProps) {
  const container = document.createElement('div');
  container.className = 'settings-page';
  container.style.cssText = `
    max-width: 600px;
    margin: 0 auto;
    padding: 0 1rem 2rem;
  `;

  const topBar = document.createElement('div');
  topBar.style.cssText = `
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    z-index: 10;
    margin-bottom: 2rem;
  `;

  const backBtn = document.createElement('button');
  backBtn.textContent = '←';
  backBtn.style.cssText = `
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-primary);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    transition: background 0.2s;
  `;
  backBtn.addEventListener('mouseenter', () => {
    backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
  });
  backBtn.addEventListener('mouseleave', () => {
    backBtn.style.background = 'none';
  });
  backBtn.addEventListener('click', () => window.history.back());

  const title = document.createElement('h1');
  title.textContent = t('settings.title');
  title.style.cssText = `
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  `;

  topBar.appendChild(backBtn);
  topBar.appendChild(title);
  container.appendChild(topBar);

  // Account Section
  if (currentUser) {
    const accountSection = document.createElement('div');
    accountSection.className = 'settings-section';
    accountSection.style.cssText = `
      margin-bottom: 2rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
    `;

    const accountTitle = document.createElement('h2');
    accountTitle.textContent = t('settings.account');
    accountTitle.style.cssText = `
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    `;

    const userChip = document.createElement('div');
    userChip.style.cssText = `
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
    `;

    const avatarUrl = currentUser.avatar_key ? `/api/images/${currentUser.avatar_key}` : '/api/images/default-avatar';
    const displayName = currentUser.display_name || currentUser.username;

    const avatarEl = document.createElement('img');
    avatarEl.src = avatarUrl;
    avatarEl.alt = '';
    avatarEl.style.cssText =
      'width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border);';
    avatarEl.onerror = () => {
      avatarEl.src = '/api/images/default-avatar';
    };
    userChip.appendChild(avatarEl);

    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'flex: 1; min-width: 0;';
    userChip.appendChild(infoDiv);

    const displayNameEl = document.createElement('div');
    displayNameEl.style.cssText =
      'font-size: 1.125rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    displayNameEl.textContent = displayName;
    infoDiv.appendChild(displayNameEl);

    const usernameEl = document.createElement('div');
    usernameEl.style.cssText =
      'color: var(--text-muted); font-family: monospace; font-size: 0.875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    usernameEl.textContent = `@${currentUser.username}`;
    infoDiv.appendChild(usernameEl);

    const logoutButton = document.createElement('button');
    logoutButton.textContent = t('auth.sign_out');
    logoutButton.style.cssText = `
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--border);
      padding: 0.75rem 1.5rem;
      border-radius: 9999px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      transition: all 0.2s;
    `;

    logoutButton.addEventListener('mouseenter', () => {
      logoutButton.style.backgroundColor = 'var(--bg-tertiary)';
    });
    logoutButton.addEventListener('mouseleave', () => {
      logoutButton.style.backgroundColor = 'var(--bg-secondary)';
    });

    logoutButton.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(t('auth.logout_confirm', { username: currentUser.username }));
      if (!confirmed) return;
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include',
        });

        if (response.ok) {
          clearMeCache();
          window.location.href = '/';
        } else {
          alert(t('auth.logout_failed'));
        }
      } catch (error) {
        console.error('Logout error:', error);
        alert(t('auth.logout_error'));
      }
    });

    const deleteButton = document.createElement('button');
    deleteButton.textContent = t('settings.delete_account');
    deleteButton.style.cssText = `
      background: transparent;
      color: var(--danger);
      border: 1px solid var(--danger);
      padding: 0.75rem 1.5rem;
      border-radius: 9999px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      transition: all 0.2s;
      margin-top: 1.5rem;
    `;

    deleteButton.addEventListener('mouseenter', () => {
      deleteButton.style.backgroundColor = 'var(--danger)';
      deleteButton.style.color = '#fff';
    });
    deleteButton.addEventListener('mouseleave', () => {
      deleteButton.style.backgroundColor = 'transparent';
      deleteButton.style.color = 'var(--danger)';
    });

    deleteButton.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(
        t('settings.delete_account_confirm', { username: currentUser.username }),
      );
      if (!confirmed) return;
      try {
        const response = await fetch('/api/users/me', {
          method: 'DELETE',
          credentials: 'include',
        });

        if (response.ok) {
          clearMeCache();
          window.location.href = '/';
        } else {
          alert(t('settings.delete_account_failed'));
        }
      } catch (error) {
        console.error('Delete account error:', error);
        alert(t('settings.delete_account_error'));
      }
    });

    accountSection.appendChild(accountTitle);
    accountSection.appendChild(userChip);
    accountSection.appendChild(logoutButton);
    accountSection.appendChild(deleteButton);
    container.appendChild(accountSection);
  }

  // Display Section
  const displaySection = document.createElement('div');
  displaySection.className = 'settings-section';
  displaySection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const displayTitle = document.createElement('h2');
  displayTitle.textContent = t('settings.display');
  displayTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const currentStyle = getReplyStyle();

  const radioGroup = document.createElement('div');
  radioGroup.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  `;

  const styles: { value: ReplyStyle; labelKey: string; descKey: string }[] = [
    { value: 'twitter', labelKey: 'settings.reply_style_twitter', descKey: 'settings.reply_style_twitter_desc' },
    { value: '2ch', labelKey: 'settings.reply_style_2ch', descKey: 'settings.reply_style_2ch_desc' },
  ];

  styles.forEach((s) => {
    const label = document.createElement('label');
    label.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.2s;
      ${currentStyle === s.value ? 'border-color: var(--accent); background: var(--bg-secondary);' : ''}
    `;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'reply-style';
    radio.value = s.value;
    radio.checked = currentStyle === s.value;
    radio.style.cssText = 'accent-color: var(--accent);';

    const textDiv = document.createElement('div');
    textDiv.style.cssText = 'display: flex; flex-direction: column;';

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem;';
    nameSpan.textContent = t(s.labelKey);

    const descSpan = document.createElement('span');
    descSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem;';
    descSpan.textContent = t(s.descKey);

    textDiv.appendChild(nameSpan);
    textDiv.appendChild(descSpan);
    label.appendChild(radio);
    label.appendChild(textDiv);
    radioGroup.appendChild(label);

    radio.addEventListener('change', () => {
      setReplyStyle(s.value);
      radioGroup.querySelectorAll('label').forEach((l) => {
        l.style.borderColor = 'var(--border)';
        l.style.background = 'none';
      });
      label.style.borderColor = 'var(--accent)';
      label.style.background = 'var(--bg-secondary)';
      displayMessage.textContent = t('settings.display_saved');
      displayMessage.style.color = 'var(--success, #10b981)';
    });
  });

  // NSFW toggle
  const nsfwLabel = document.createElement('label');
  nsfwLabel.style.cssText = `
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.2s;
    margin-bottom: 1rem;
  `;

  const nsfwCheckbox = document.createElement('input');
  nsfwCheckbox.type = 'checkbox';
  nsfwCheckbox.checked = getShowNsfw();
  nsfwCheckbox.style.cssText = 'accent-color: var(--accent); width: 18px; height: 18px; cursor: pointer;';

  const nsfwTextDiv = document.createElement('div');
  nsfwTextDiv.style.cssText = 'display: flex; flex-direction: column;';

  const nsfwNameSpan = document.createElement('span');
  nsfwNameSpan.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem;';
  nsfwNameSpan.textContent = t('settings.nsfw');

  const nsfwDescSpan = document.createElement('span');
  nsfwDescSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem;';
  nsfwDescSpan.textContent = t('settings.nsfw_desc');

  nsfwTextDiv.appendChild(nsfwNameSpan);
  nsfwTextDiv.appendChild(nsfwDescSpan);
  nsfwLabel.appendChild(nsfwCheckbox);
  nsfwLabel.appendChild(nsfwTextDiv);

  nsfwCheckbox.addEventListener('change', () => {
    setShowNsfw(nsfwCheckbox.checked);
    displayMessage.textContent = t('settings.display_saved');
    displayMessage.style.color = 'var(--success, #10b981)';
  });

  // Theme selector
  const themeTitle = document.createElement('div');
  themeTitle.style.cssText = `
    font-weight: 600;
    color: var(--text-primary);
    font-size: 0.9375rem;
    margin-top: 0.5rem;
    margin-bottom: 0.5rem;
  `;
  themeTitle.textContent = t('settings.theme');

  const currentTheme = getTheme();
  const themeRadioGroup = document.createElement('div');
  themeRadioGroup.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  `;

  const themes: { value: Theme; labelKey: string; descKey: string }[] = [
    { value: 'light', labelKey: 'settings.theme_light', descKey: 'settings.theme_light_desc' },
    { value: 'dark', labelKey: 'settings.theme_dark', descKey: 'settings.theme_dark_desc' },
    { value: 'system', labelKey: 'settings.theme_system', descKey: 'settings.theme_system_desc' },
  ];

  themes.forEach((st) => {
    const label = document.createElement('label');
    label.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.2s;
      ${currentTheme === st.value ? 'border-color: var(--accent); background: var(--bg-secondary);' : ''}
    `;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'theme';
    radio.value = st.value;
    radio.checked = currentTheme === st.value;
    radio.style.cssText = 'accent-color: var(--accent);';

    const textDiv = document.createElement('div');
    textDiv.style.cssText = 'display: flex; flex-direction: column;';

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem;';
    nameSpan.textContent = t(st.labelKey);

    const descSpan = document.createElement('span');
    descSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem;';
    descSpan.textContent = t(st.descKey);

    textDiv.appendChild(nameSpan);
    textDiv.appendChild(descSpan);
    label.appendChild(radio);
    label.appendChild(textDiv);
    themeRadioGroup.appendChild(label);

    radio.addEventListener('change', () => {
      setTheme(st.value);
      themeRadioGroup.querySelectorAll('label').forEach((l) => {
        l.style.borderColor = 'var(--border)';
        l.style.background = 'none';
      });
      label.style.borderColor = 'var(--accent)';
      label.style.background = 'var(--bg-secondary)';
      displayMessage.textContent = t('settings.display_saved');
      displayMessage.style.color = 'var(--success, #10b981)';
    });
  });

  const displayMessage = document.createElement('div');
  displayMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

  displaySection.appendChild(displayTitle);
  displaySection.appendChild(radioGroup);
  displaySection.appendChild(nsfwLabel);
  displaySection.appendChild(themeTitle);
  displaySection.appendChild(themeRadioGroup);
  displaySection.appendChild(displayMessage);

  container.appendChild(displaySection);

  // Language Section
  const languageSection = document.createElement('div');
  languageSection.className = 'settings-section';
  languageSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const languageTitle = document.createElement('h2');
  languageTitle.textContent = t('settings.language');
  languageTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const languageSelect = document.createElement('select');
  languageSelect.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    cursor: pointer;
  `;

  fetch('/locales/index.json')
    .then((r) => r.json())
    .then((locales) => {
      languageSelect.innerHTML = '';
      (locales as { code: string; nativeName: string }[]).forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l.code;
        opt.textContent = l.nativeName;
        languageSelect.appendChild(opt);
      });
      if (currentUser?.language) {
        languageSelect.value = currentUser.language;
      } else {
        languageSelect.value = getLocale();
      }
    })
    .catch(() => {
      ['en', 'ja'].forEach((code) => {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = code;
        languageSelect.appendChild(opt);
      });
    });

  // Set current language
  if (currentUser?.language) {
    languageSelect.value = currentUser.language;
  }

  const languageSaveButton = document.createElement('button');
  languageSaveButton.textContent = t('common.save');
  languageSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `;

  const languageMessage = document.createElement('div');
  languageMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

  languageSection.appendChild(languageTitle);
  languageSection.appendChild(languageSelect);
  languageSection.appendChild(languageSaveButton);
  languageSection.appendChild(languageMessage);

  // Email Section
  const emailSection = document.createElement('div');
  emailSection.className = 'settings-section';
  emailSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const emailTitle = document.createElement('h2');
  emailTitle.textContent = t('settings.change_email');
  emailTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const currentPasswordLabel = document.createElement('label');
  currentPasswordLabel.textContent = t('settings.email_current_password');
  currentPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const currentPasswordInput = document.createElement('input');
  currentPasswordInput.type = 'password';
  currentPasswordInput.placeholder = t('settings.email_current_password_placeholder');
  currentPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const newEmailLabel = document.createElement('label');
  newEmailLabel.textContent = t('settings.email_new_email');
  newEmailLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const newEmailInput = document.createElement('input');
  newEmailInput.type = 'email';
  newEmailInput.placeholder = t('settings.email_new_email_placeholder');
  newEmailInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const emailSaveButton = document.createElement('button');
  emailSaveButton.textContent = t('common.save');
  emailSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `;

  const emailMessage = document.createElement('div');
  emailMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

  emailSection.appendChild(emailTitle);
  emailSection.appendChild(currentPasswordLabel);
  emailSection.appendChild(currentPasswordInput);
  emailSection.appendChild(newEmailLabel);
  emailSection.appendChild(newEmailInput);
  emailSection.appendChild(emailSaveButton);
  emailSection.appendChild(emailMessage);

  // Password Section
  const passwordSection = document.createElement('div');
  passwordSection.className = 'settings-section';
  passwordSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `;

  const passwordTitle = document.createElement('h2');
  passwordTitle.textContent = t('settings.change_password');
  passwordTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `;

  const currentPasswordLabel2 = document.createElement('label');
  currentPasswordLabel2.textContent = t('settings.password_current');
  currentPasswordLabel2.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const currentPasswordInput2 = document.createElement('input');
  currentPasswordInput2.type = 'password';
  currentPasswordInput2.placeholder = t('settings.password_current_placeholder');
  currentPasswordInput2.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const newPasswordLabel = document.createElement('label');
  newPasswordLabel.textContent = t('settings.password_new');
  newPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const newPasswordInput = document.createElement('input');
  newPasswordInput.type = 'password';
  newPasswordInput.placeholder = t('settings.password_new_placeholder');
  newPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const confirmPasswordLabel = document.createElement('label');
  confirmPasswordLabel.textContent = t('settings.password_confirm');
  confirmPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `;

  const confirmPasswordInput = document.createElement('input');
  confirmPasswordInput.type = 'password';
  confirmPasswordInput.placeholder = t('settings.password_confirm_placeholder');
  confirmPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `;

  const passwordSaveButton = document.createElement('button');
  passwordSaveButton.textContent = t('common.save');
  passwordSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `;

  const passwordMessage = document.createElement('div');
  passwordMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `;

  passwordSection.appendChild(passwordTitle);
  passwordSection.appendChild(currentPasswordLabel2);
  passwordSection.appendChild(currentPasswordInput2);
  passwordSection.appendChild(newPasswordLabel);
  passwordSection.appendChild(newPasswordInput);
  passwordSection.appendChild(confirmPasswordLabel);
  passwordSection.appendChild(confirmPasswordInput);
  passwordSection.appendChild(passwordSaveButton);
  passwordSection.appendChild(passwordMessage);

  // Event handlers
  languageSaveButton.addEventListener('click', async () => {
    const language = languageSelect.value;
    languageMessage.textContent = '';
    languageSaveButton.disabled = true;
    languageSaveButton.style.opacity = '0.6';

    try {
      const response = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ language }),
      });

      if (response.ok) {
        languageMessage.textContent = t('settings.language_saved');
        languageMessage.style.color = 'var(--success, #10b981)';
        await setLocale(language);
        location.reload();
      } else {
        const errorData = (await response.json()) as { error?: string };
        languageMessage.textContent = errorData.error || t('settings.language_save_failed');
        languageMessage.style.color = 'var(--danger)';
      }
    } catch (_error: unknown) {
      languageMessage.textContent = t('settings.language_network_error');
      languageMessage.style.color = 'var(--danger)';
    } finally {
      languageSaveButton.disabled = false;
      languageSaveButton.style.opacity = '1';
    }
  });

  emailSaveButton.addEventListener('click', async () => {
    const currentPassword = currentPasswordInput.value.trim();
    const newEmail = newEmailInput.value.trim();

    if (!currentPassword || !newEmail) {
      emailMessage.textContent = t('settings.email_fill_all');
      emailMessage.style.color = 'var(--danger)';
      return;
    }

    emailMessage.textContent = '';
    emailSaveButton.disabled = true;
    emailSaveButton.style.opacity = '0.6';

    try {
      const response = await fetch('/api/users/me/email', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ current_password: currentPassword, new_email: newEmail }),
      });

      if (response.ok) {
        emailMessage.textContent = t('settings.email_saved');
        emailMessage.style.color = 'var(--success, #10b981)';
        currentPasswordInput.value = '';
        newEmailInput.value = '';
      } else {
        const errorData = (await response.json()) as { error?: string };
        emailMessage.textContent = errorData.error || t('settings.email_save_failed');
        emailMessage.style.color = 'var(--danger)';
      }
    } catch (_error: unknown) {
      emailMessage.textContent = t('settings.email_network_error');
      emailMessage.style.color = 'var(--danger)';
    } finally {
      emailSaveButton.disabled = false;
      emailSaveButton.style.opacity = '1';
    }
  });

  passwordSaveButton.addEventListener('click', async () => {
    const currentPassword = currentPasswordInput2.value.trim();
    const newPassword = newPasswordInput.value.trim();
    const confirmPassword = confirmPasswordInput.value.trim();

    if (!currentPassword || !newPassword || !confirmPassword) {
      passwordMessage.textContent = t('settings.password_fill_all');
      passwordMessage.style.color = 'var(--danger)';
      return;
    }

    if (newPassword !== confirmPassword) {
      passwordMessage.textContent = t('settings.password_mismatch');
      passwordMessage.style.color = 'var(--danger)';
      return;
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
      passwordMessage.textContent = t('settings.password_length');
      passwordMessage.style.color = 'var(--danger)';
      return;
    }

    passwordMessage.textContent = '';
    passwordSaveButton.disabled = true;
    passwordSaveButton.style.opacity = '0.6';

    try {
      // Derive a fresh SRP verifier from the new password so the single account
      // password also protects E2EE after the change.
      const salt = generateSalt();
      const verifier = await computeVerifier(newPassword, salt);

      // Prove knowledge of the CURRENT password via an SRP handshake so SRP-only
      // accounts (no legacy hash) are still verified before the change.
      let currentSrp: { challenge_id: string; A: string; M1: string } | undefined;
      const reauth = await fetch('/api/auth/reauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (reauth.ok) {
        const r = (await reauth.json()) as { challenge_id: string; salt: string; B: string };
        const { A, a } = await clientStep1(currentPassword, unb64(r.salt));
        const finish = await clientStep2(currentPassword, unb64(r.salt), a, unb64(r.B));
        currentSrp = { challenge_id: r.challenge_id, A: b64(A), M1: b64(finish.M1) };
      }

      const response = await fetch('/api/users/me/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
          srp_salt: b64(salt),
          srp_verifier: b64(verifier),
          srp_group: '2048',
          current_srp: currentSrp,
        }),
      });

      if (response.ok) {
        storeSrpSalt(salt);
        // Ensure the E2EE identity is unlocked with the OLD password before
        // re-wrapping, so the re-wrap never silently fails when the identity
        // was not yet in memory this session.
        await unlockIdentityV2WithPassword(currentPassword);
        // Re-wrap the E2EE identity with the new KEK (keeps identity keys).
        await rewrapE2EEIdentityV2(newPassword, salt);
        passwordMessage.textContent = t('settings.password_saved');
        passwordMessage.style.color = 'var(--success, #10b981)';
        currentPasswordInput2.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
      } else {
        const errorData = (await response.json()) as { error?: string };
        passwordMessage.textContent = errorData.error || t('settings.password_save_failed');
        passwordMessage.style.color = 'var(--danger)';
      }
    } catch (_error: unknown) {
      passwordMessage.textContent = t('settings.password_network_error');
      passwordMessage.style.color = 'var(--danger)';
    } finally {
      passwordSaveButton.disabled = false;
      passwordSaveButton.style.opacity = '1';
    }
  });

  // Add hover effects
  const buttons = [languageSaveButton, emailSaveButton, passwordSaveButton];
  buttons.forEach((button: HTMLButtonElement) => {
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) {
        button.style.opacity = '0.8';
      }
    });
    button.addEventListener('mouseleave', () => {
      if (!button.disabled) {
        button.style.opacity = '1';
      }
    });
  });

  container.appendChild(languageSection);
  container.appendChild(emailSection);
  container.appendChild(passwordSection);

  // ─── Custom Emoji Section ────────────────────────────────────────────────
  if (currentUser) {
    const emojiSection = document.createElement('div');
    emojiSection.className = 'settings-section';
    emojiSection.style.cssText = `
      margin-bottom: 2rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
    `;

    const emojiTitle = document.createElement('h2');
    emojiTitle.textContent = t('settings.custom_emoji') || 'Custom Emoji';
    emojiTitle.style.cssText = `
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    `;

    const emojiDesc = document.createElement('p');
    emojiDesc.textContent =
      t('settings.custom_emoji_desc') ||
      'Create custom emoji like :working_me: to use in reactions and messages. Only you can use your custom emoji, but others can see them.';
    emojiDesc.style.cssText = 'color: var(--text-muted); font-size: 0.875rem; margin-bottom: 1rem;';

    const emojiCountRow = document.createElement('div');
    emojiCountRow.style.cssText = 'display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;';
    const emojiCountLabel = document.createElement('span');
    emojiCountLabel.style.cssText = 'font-size: 0.875rem; color: var(--text-muted);';
    const emojiCountValue = document.createElement('span');
    emojiCountValue.style.cssText = 'font-weight: 600; color: var(--text-primary);';
    emojiCountLabel.textContent = t('settings.custom_emoji_count') || 'Emoji used:';
    emojiCountValue.textContent = '...';
    emojiCountRow.appendChild(emojiCountLabel);
    emojiCountRow.appendChild(emojiCountValue);

    // Upload form
    const uploadRow = document.createElement('div');
    uploadRow.style.cssText = 'display: flex; gap: 0.5rem; margin-bottom: 1rem; align-items: center;';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = ':name:';
    nameInput.style.cssText = `
      flex: 1;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 0.875rem;
      font-family: monospace;
    `;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
    fileInput.style.cssText = 'font-size: 0.875rem;';

    const uploadBtn = document.createElement('button');
    uploadBtn.textContent = t('settings.custom_emoji_upload') || 'Upload';
    uploadBtn.style.cssText = `
      background: var(--accent);
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      white-space: nowrap;
    `;

    const uploadMsg = document.createElement('div');
    uploadMsg.style.cssText = 'font-size: 0.8125rem; min-height: 1.25rem; margin-bottom: 0.5rem;';

    uploadRow.appendChild(nameInput);
    uploadRow.appendChild(fileInput);
    uploadRow.appendChild(uploadBtn);

    // Stamps list
    const stampsGrid = document.createElement('div');
    stampsGrid.style.cssText =
      'display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 0.75rem;';

    function loadStamps() {
      fetch('/api/stamps', { credentials: 'include' })
        .then((r) => r.json() as Promise<{ stamps: Array<{ id: string; name: string; url: string }> }>)
        .then((data) => {
          stampsGrid.innerHTML = '';
          emojiCountValue.textContent = `${data.stamps.length} / 5`;
          for (const stamp of data.stamps) {
            const card = document.createElement('div');
            card.style.cssText = `
              border: 1px solid var(--border);
              border-radius: 6px;
              padding: 0.5rem;
              text-align: center;
              background: var(--bg-secondary);
              position: relative;
            `;
            const img = document.createElement('img');
            img.src = stamp.url;
            img.alt = stamp.name;
            img.style.cssText = 'width: 48px; height: 48px; object-fit: contain; margin-bottom: 0.25rem;';
            const label = document.createElement('div');
            label.style.cssText =
              'font-size: 0.75rem; color: var(--text-muted); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
            label.textContent = stamp.name;
            label.title = stamp.name;
            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.style.cssText = `
              position: absolute;
              top: 2px;
              right: 4px;
              background: var(--danger, #ef4444);
              color: white;
              border: none;
              border-radius: 50%;
              width: 18px;
              height: 18px;
              font-size: 10px;
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: center;
              line-height: 1;
            `;
            delBtn.addEventListener('click', async () => {
              if (!confirm(t('settings.custom_emoji_delete_confirm', { name: stamp.name }) || `Delete ${stamp.name}?`))
                return;
              const res = await fetch(`/api/stamps/${stamp.id}`, { method: 'DELETE', credentials: 'include' });
              if (res.ok) loadStamps();
              else uploadMsg.textContent = t('settings.custom_emoji_delete_failed') || 'Failed to delete';
            });
            card.appendChild(img);
            card.appendChild(label);
            card.appendChild(delBtn);
            stampsGrid.appendChild(card);
          }
        })
        .catch(() => {
          stampsGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:1rem;">${t('settings.custom_emoji_load_failed') || 'Failed to load stamps'}</div>`;
        });
    }

    uploadBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const file = fileInput.files?.[0];
      if (!name || !file) {
        uploadMsg.textContent = t('settings.custom_emoji_fill_all') || 'Please enter a name and select a file';
        uploadMsg.style.color = 'var(--danger)';
        return;
      }
      if (!/^:[a-zA-Z0-9_]+:$/.test(name)) {
        uploadMsg.textContent = t('settings.custom_emoji_name_format') || 'Name must be in :colon_format:';
        uploadMsg.style.color = 'var(--danger)';
        return;
      }
      uploadBtn.disabled = true;
      uploadMsg.textContent = '';
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', name);
      try {
        const res = await fetch('/api/stamps', { method: 'POST', credentials: 'include', body: formData });
        if (res.ok) {
          nameInput.value = '';
          fileInput.value = '';
          uploadMsg.textContent = t('settings.custom_emoji_uploaded') || 'Uploaded!';
          uploadMsg.style.color = 'var(--success, #10b981)';
          loadStamps();
        } else {
          const err = (await res.json()) as { error?: string };
          uploadMsg.textContent = err.error || t('settings.custom_emoji_upload_failed') || 'Upload failed';
          uploadMsg.style.color = 'var(--danger)';
        }
      } catch {
        uploadMsg.textContent = t('settings.custom_emoji_network_error') || 'Network error';
        uploadMsg.style.color = 'var(--danger)';
      }
      uploadBtn.disabled = false;
    });

    emojiSection.appendChild(emojiTitle);
    emojiSection.appendChild(emojiDesc);
    emojiSection.appendChild(emojiCountRow);
    emojiSection.appendChild(uploadRow);
    emojiSection.appendChild(uploadMsg);
    emojiSection.appendChild(stampsGrid);
    container.appendChild(emojiSection);

    loadStamps();
  }

  // Billing Section
  if (currentUser) {
    const billingSection = document.createElement('div');
    billingSection.className = 'settings-section';
    billingSection.style.cssText = `
      margin-bottom: 2rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
    `;

    const billingTitle = document.createElement('h2');
    billingTitle.textContent = t('settings.billing') || 'Billing & Plans';
    billingTitle.style.cssText = `
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    `;

    billingSection.appendChild(billingTitle);

    // Current plan display
    const planInfo = document.createElement('div');
    planInfo.style.cssText = `
      padding: 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 1rem;
      background: var(--bg-secondary);
    `;
    const planLabel = document.createElement('div');
    planLabel.style.cssText = 'font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.5rem;';
    planLabel.textContent = t('settings.current_plan') || 'Current Plan';
    const planName = document.createElement('div');
    planName.style.cssText = 'font-weight: 600; font-size: 1.125rem; color: var(--text-primary);';
    planName.textContent = t('settings.loading') || 'Loading...';
    planInfo.appendChild(planLabel);
    planInfo.appendChild(planName);
    billingSection.appendChild(planInfo);

    // Fetch current plan
    fetch('/api/billing/plan')
      .then((r) => r.json() as Promise<{ plan: string | null }>)
      .then((data) => {
        const planNames: Record<string, string> = {
          flaxia_plus: 'Flaxia+ (¥150/mo)',
          flaxia_plus_plus: 'Flaxia++ (¥500/mo)',
          flaxia_sharp: 'Flaxia# (¥1000/mo)',
        };
        planName.textContent = data.plan ? planNames[data.plan] || data.plan : t('settings.free_plan') || 'Flaxia Free';
      })
      .catch(() => {
        planName.textContent = t('settings.free_plan') || 'Flaxia Free';
      });

    // Plan cards
    const plans = [
      {
        id: 'flaxia_plus',
        name: 'Flaxia+',
        price: '¥150',
        period: '/mo',
        features: [
          t('settings.plan_plus_f1') || 'Unlimited custom stamps',
          t('settings.plan_plus_f2') || 'GIF & MP4 stamps/icons/intro',
          t('settings.plan_plus_f3') || 'Improved call quality',
        ],
        color: '#8b5cf6',
      },
      // --- Flaxia++ / Flaxia# are temporarily hidden ---
      // {
      //   id: 'flaxia_plus_plus',
      //   name: 'Flaxia++',
      //   price: '¥500',
      //   period: '/mo',
      //   features: [
      //     t('settings.plan_plusplus_f1') || 'Everything in Flaxia+',
      //     t('settings.plan_plusplus_f2') || 'Offline games, images, videos & music',
      //     t('settings.plan_plusplus_f3') || 'Premium call quality',
      //   ],
      //   color: '#f59e0b',
      // },
      // {
      //   id: 'flaxia_sharp',
      //   name: 'Flaxia#',
      //   price: '¥1000',
      //   period: '/mo',
      //   features: [
      //     t('settings.plan_sharp_f1') || 'Everything in Flaxia++',
      //     t('settings.plan_sharp_f2') || 'Access to preview branches',
      //     t('settings.plan_sharp_f3') || 'Use experimental features',
      //   ],
      //   color: '#ef4444',
      // },
    ];

    const plansGrid = document.createElement('div');
    plansGrid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 1rem;
      margin-bottom: 1rem;
    `;

    plans.forEach((plan) => {
      const card = document.createElement('div');
      card.style.cssText = `
        border: 2px solid var(--border);
        border-radius: 8px;
        padding: 1rem;
        cursor: pointer;
        transition: border-color 0.2s, transform 0.1s;
      `;
      card.addEventListener('mouseenter', () => {
        card.style.borderColor = plan.color;
        card.style.transform = 'translateY(-2px)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.borderColor = 'var(--border)';
        card.style.transform = 'none';
      });

      const nameEl = document.createElement('div');
      nameEl.style.cssText = `font-weight: 700; font-size: 1rem; color: ${plan.color}; margin-bottom: 0.25rem;`;
      nameEl.textContent = plan.name;

      const priceEl = document.createElement('div');
      priceEl.style.cssText = 'margin-bottom: 0.75rem;';
      const priceNum = document.createElement('span');
      priceNum.style.cssText = 'font-size: 1.5rem; font-weight: 700; color: var(--text-primary);';
      priceNum.textContent = plan.price;
      const pricePeriod = document.createElement('span');
      pricePeriod.style.cssText = 'font-size: 0.875rem; color: var(--text-muted);';
      pricePeriod.textContent = plan.period;
      priceEl.appendChild(priceNum);
      priceEl.appendChild(pricePeriod);

      const featuresEl = document.createElement('ul');
      featuresEl.style.cssText = 'list-style: none; padding: 0; margin: 0;';
      plan.features.forEach((f) => {
        const li = document.createElement('li');
        li.style.cssText = 'font-size: 0.8125rem; color: var(--text-secondary); padding: 0.25rem 0;';
        li.textContent = `✓ ${f}`;
        featuresEl.appendChild(li);
      });

      const buyBtn = document.createElement('button');
      buyBtn.textContent = t('settings.subscribe') || 'Subscribe';
      buyBtn.style.cssText = `
        width: 100%;
        margin-top: 0.75rem;
        padding: 0.5rem;
        border: none;
        border-radius: 6px;
        background: ${plan.color};
        color: white;
        font-weight: 600;
        font-size: 0.875rem;
        cursor: pointer;
        transition: opacity 0.2s;
      `;
      buyBtn.addEventListener('mouseenter', () => {
        if (!buyBtn.disabled) buyBtn.style.opacity = '0.85';
      });
      buyBtn.addEventListener('mouseleave', () => {
        if (!buyBtn.disabled) buyBtn.style.opacity = '1';
      });
      buyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        buyBtn.disabled = true;
        buyBtn.textContent = t('settings.redirecting') || 'Redirecting...';
        try {
          const res = await fetch('/api/billing/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ planId: plan.id, mode: 'subscription' }),
          });
          const data = (await res.json()) as { url?: string; error?: string };
          if (data.url) {
            window.location.href = data.url;
          } else {
            alert(data.error || 'Failed to create checkout session');
            buyBtn.disabled = false;
            buyBtn.textContent = t('settings.subscribe') || 'Subscribe';
          }
        } catch {
          alert(t('settings.network_error') || 'Network error');
          buyBtn.disabled = false;
          buyBtn.textContent = t('settings.subscribe') || 'Subscribe';
        }
      });

      card.appendChild(nameEl);
      card.appendChild(priceEl);
      card.appendChild(featuresEl);
      card.appendChild(buyBtn);
      plansGrid.appendChild(card);
    });

    billingSection.appendChild(plansGrid);
    container.appendChild(billingSection);
  }

  return {
    getElement: () => container,
    destroy: () => {
      container.remove();
    },
  };
}
