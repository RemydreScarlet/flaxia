import { t } from '../lib/i18n.js';
import { unlockIdentityFromSession } from '../lib/messenger-store.js';
import { DmTransport } from './chat/dm.js';
import { MessageView } from './chat/MessageView.js';

export interface ConversationViewProps {
  conversationId: string;
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onBack: () => void;
  onMenu?: () => void;
}

export class ConversationView extends MessageView {
  private readonly props: ConversationViewProps;
  private readonly dm: DmTransport;

  constructor(props: ConversationViewProps) {
    super('conv');
    this.props = props;
    this.dm = new DmTransport(props.conversationId);
    this.transport = this.dm;
    this.element = this.createElement();
    void this.load();
  }

  private async load(): Promise<void> {
    await this.unlockIdentity();
    await this.loadConversation();
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
    container.className = 'conversation-view';

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

    container.appendChild(header);
    container.appendChild(this.buildMessagesArea());
    container.appendChild(this.buildComposer());
    return container;
  }

  private async loadConversation(): Promise<void> {
    try {
      const res = await fetch(`/api/dm/conversations/${this.props.conversationId}`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as {
          id: string;
          key_version?: number;
          other_user: { id: string; username: string; display_name: string; avatar_key: string | null };
        };
        await this.dm.setPeer(data.other_user.id, data.key_version || 1);
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
        if (name) name.textContent = data.other_user.display_name || data.other_user.username;
      }
    } catch {
      /* ignore */
    }

    await this.fetchMessages(true);
    void this.markRead();
    this.startPolling();
  }
}

export function createConversationView(props: ConversationViewProps): ConversationView {
  return new ConversationView(props);
}
