import type { ChatMessage, ChatSender, MessageScope } from './types.js';

export interface ApiMessage {
  id: string;
  conversation_id?: string;
  group_id?: string;
  channel_id?: string;
  sender_id: string;
  content: string;
  gif_key?: string | null;
  payload_key?: string | null;
  swf_key?: string | null;
  content_iv?: string | null;
  enc_version?: number | null;
  key_version?: number | null;
  plaintext_enc?: string | null;
  plaintext_iv?: string | null;
  ratchet_pub?: string | null;
  ratchet_pn?: number | null;
  ratchet_n?: number | null;
  reply_to_id?: string | null;
  pinned?: number | null;
  stamp_id?: string | null;
  stamp_url?: string | null;
  stamp_name?: string | null;
  created_at: string;
  edited_at?: string | null;
  is_mine: boolean;
  sender: {
    id?: string;
    username: string;
    display_name: string;
    avatar_key?: string | null;
  };
}

export function mapSender(s: ApiMessage['sender']): ChatSender {
  return {
    id: s.id,
    username: s.username,
    display_name: s.display_name,
    avatar_key: s.avatar_key ?? null,
  };
}

export function mapMessage(raw: ApiMessage, scope: MessageScope, contextId: string): ChatMessage {
  return {
    id: raw.id,
    scope,
    contextId,
    sender_id: raw.sender_id,
    sender: mapSender(raw.sender),
    content: raw.content,
    gif_key: raw.gif_key ?? null,
    payload_key: raw.payload_key ?? null,
    swf_key: raw.swf_key ?? null,
    content_iv: raw.content_iv ?? null,
    enc_version: raw.enc_version ?? null,
    key_version: raw.key_version ?? null,
    plaintext_enc: raw.plaintext_enc ?? null,
    plaintext_iv: raw.plaintext_iv ?? null,
    ratchet_pub: raw.ratchet_pub ?? null,
    ratchet_pn: raw.ratchet_pn ?? null,
    ratchet_n: raw.ratchet_n ?? null,
    reply_to_id: raw.reply_to_id ?? null,
    pinned: raw.pinned ?? null,
    stamp_id: raw.stamp_id ?? null,
    stamp_url: raw.stamp_url ?? null,
    stamp_name: raw.stamp_name ?? null,
    created_at: raw.created_at,
    edited_at: raw.edited_at ?? null,
    is_mine: raw.is_mine,
  };
}
