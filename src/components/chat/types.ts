export type MessageScope = 'dm' | 'group' | 'server-channel';

export interface ChatSender {
  id?: string;
  username: string;
  display_name: string;
  avatar_key?: string | null;
}

export interface ChatMessage {
  id: string;
  scope: MessageScope;
  contextId: string;
  sender_id: string;
  sender: ChatSender;
  content: string;
  gif_key?: string | null;
  payload_key?: string | null;
  swf_key?: string | null;
  content_iv?: string | null;
  enc_version?: number | null;
  key_version?: number | null;
  ratchet_pub?: string | null;
  ratchet_pn?: number | null;
  ratchet_n?: number | null;
  reply_to_id?: string | null;
  pinned?: number | null;
  created_at: string;
  edited_at?: string | null;
  is_mine: boolean;
}

/**
 * Per-scope transport. Isolates the only real differences between the DM,
 * group and server-channel message views: the REST endpoints and the
 * E2EE crypto. Everything else (row rendering, grouping, composer, polling
 * loop, send/edit/delete orchestration) lives in `MessageView`.
 */
export interface MessageTransport {
  readonly scope: MessageScope;

  /** Fetch a page of messages. Implementations return raw API order (newest first). */
  fetchMessages(cursor: string | null, limit: number): Promise<{ messages: ChatMessage[]; nextCursor: string | null }>;

  /** Poll for messages newer than `cursor`. Implementations return raw API order (newest first). */
  pollMessages(cursor: string): Promise<ChatMessage[]>;

  /** Mark the active context as read. */
  markRead(): Promise<void>;

  /** Delete a message. Resolves true on success. */
  deleteMessage(messageId: string): Promise<boolean>;

  /** Send a new message (with optional file). Resolves with the created message, or null on failure. */
  sendMessage(opts: { content: string; file: File | null }): Promise<ChatMessage | null>;

  /** Edit an existing message. Resolves with the updated message fields, or null on failure. */
  editMessage(messageId: string, content: string): Promise<Partial<ChatMessage> | null>;

  /** Plaintext to populate the composer when editing (decrypts for server, raw for dm/group). */
  startEditDecrypt(msg: ChatMessage): Promise<string>;

  /** Decrypt and enrich an encrypted message body in place. */
  decryptTextInto(el: HTMLElement, msg: ChatMessage): Promise<void>;

  /** Render an attachment into `container` (async-safe; checks `container.isConnected`). */
  renderAttachment(container: HTMLElement, msg: ChatMessage): void;
}
