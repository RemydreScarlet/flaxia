import {
  BarChart3,
  Bookmark,
  Copy,
  createElement,
  Eye,
  type IconNode,
  Leaf,
  MessageCircle,
  Quote,
  Save,
  Send,
  Share2,
  StickyNote,
  Upload,
  X,
} from 'lucide';

export type IconName =
  | 'fresh'
  | 'bookmark'
  | 'reply'
  | 'share'
  | 'quote'
  | 'impressions'
  | 'attach'
  | 'poll'
  | 'save'
  | 'drafts'
  | 'close'
  | 'copy'
  | 'send';

const ICON_NODES: Record<IconName, IconNode> = {
  fresh: Leaf,
  bookmark: Bookmark,
  reply: MessageCircle,
  share: Share2,
  quote: Quote,
  impressions: Eye,
  attach: Upload,
  poll: BarChart3,
  save: Save,
  drafts: StickyNote,
  close: X,
  copy: Copy,
  send: Send,
};

export function icon(name: IconName, attrs: Record<string, string> = {}): SVGElement {
  const el = createElement(ICON_NODES[name]);
  el.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/**
 * Replaces `[data-icon="<name>"]` placeholder elements inside root with the
 * corresponding Lucide SVG. Used for `innerHTML`-based templates.
 */
export function attachIcons(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    if (el.childNodes.length > 0) return;
    const name = (el.getAttribute('data-icon') || '') as IconName;
    if (!(name in ICON_NODES)) return;
    el.appendChild(createElement(ICON_NODES[name]));
  });
}
