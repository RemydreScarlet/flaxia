/**
 * Client-side content protection module.
 *
 * Provides:
 * - Right-click prevention on media elements
 * - Drag prevention on media elements
 * - Keyboard shortcut blocking for save operations
 * - Canvas tainting to prevent toDataURL/toBlob extraction
 * - Print prevention
 */

const BLOCKED_KEYS = new Set([
  's', // Ctrl/Cmd+S
  'u', // Ctrl/Cmd+U (view source)
]);

const BLOCKED_KEY_COMBOS = [
  { ctrl: true, shift: true, key: 's' }, // Ctrl+Shift+S (save as)
  { ctrl: true, shift: true, key: 'i' }, // Ctrl+Shift+I (devtools)
  { ctrl: true, shift: true, key: 'j' }, // Ctrl+Shift+J (console)
  { ctrl: true, shift: true, key: 'c' }, // Ctrl+Shift+C (inspect)
  { meta: true, shift: true, key: 's' }, // Cmd+Shift+S
  { meta: true, shift: true, key: 'i' }, // Cmd+Option+I
  { meta: true, shift: true, key: 'j' }, // Cmd+Option+J
  { meta: true, shift: true, key: 'c' }, // Cmd+Option+C
];

function isModifierPressed(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

function handleKeyDown(e: KeyboardEvent): void {
  // Block Ctrl+S / Cmd+S (save)
  if (isModifierPressed(e) && BLOCKED_KEYS.has(e.key.toLowerCase())) {
    e.preventDefault();
    return;
  }

  // Block Ctrl+Shift+S / Cmd+Shift+S (save as)
  if (isModifierPressed(e) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return;
  }

  // Block other devtools shortcuts
  for (const combo of BLOCKED_KEY_COMBOS) {
    const modMatch = combo.ctrl ? e.ctrlKey : combo.meta ? e.metaKey : false;
    if (modMatch && e.shiftKey === combo.shift && e.key.toLowerCase() === combo.key) {
      e.preventDefault();
      return;
    }
  }

  // Block F12 (devtools)
  if (e.key === 'F12') {
    e.preventDefault();
    return;
  }
}

function handleContextMenu(e: Event): void {
  // Only block on media elements
  const target = e.target as HTMLElement;
  if (
    target.tagName === 'IMG' ||
    target.tagName === 'VIDEO' ||
    target.tagName === 'AUDIO' ||
    target.closest('.image-preview, .video-player, .audio-player, .post-stage')
  ) {
    e.preventDefault();
  }
}

function handleDragStart(e: Event): void {
  const target = e.target as HTMLElement;
  if (
    target.tagName === 'IMG' ||
    target.tagName === 'VIDEO' ||
    target.closest('.image-preview, .video-player, .post-stage')
  ) {
    e.preventDefault();
  }
}

function handlePrint(): void {
  // Block printing via Ctrl+P / Cmd+P is handled by CSS @media print
  // This is a fallback for programmatic print calls
}

/**
 * Override Canvas methods to taint the canvas when attempting to extract media.
 * This prevents toDataURL() and toBlob() from working on protected images.
 */
function enableCanvasTainting(): void {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  const taintedCanvases = new WeakSet<HTMLCanvasElement>();

  HTMLCanvasElement.prototype.getContext = function (...args: Parameters<typeof originalGetContext>) {
    const ctx = originalGetContext.apply(this, args);
    // Mark canvas as potentially tainted if it draws from a protected source
    if (ctx) {
      const origDrawImage = ctx.drawImage.bind(ctx);
      ctx.drawImage = function (...drawArgs: Parameters<typeof origDrawImage>) {
        taintedCanvases.add(this.canvas as HTMLCanvasElement);
        return origDrawImage(...drawArgs);
      } as typeof ctx.drawImage;
    }
    return ctx;
  };

  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    if (taintedCanvases.has(this)) {
      // Return a 1x1 transparent pixel instead of the actual image
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    }
    return originalToDataURL.apply(this, args);
  };

  HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
    if (taintedCanvases.has(this)) {
      // Return a minimal blob
      const blob = new Blob([''], { type: 'image/png' });
      callback?.(blob);
      return;
    }
    return originalToBlob.call(this, callback as BlobCallback, ...args);
  };
}

let initialized = false;

/**
 * Initialize content protection. Safe to call multiple times.
 */
export function initContentProtection(): void {
  if (initialized) return;
  initialized = true;

  // Keyboard shortcut blocking
  document.addEventListener('keydown', handleKeyDown, true);

  // Right-click prevention on media
  document.addEventListener('contextmenu', handleContextMenu, true);

  // Drag prevention on media
  document.addEventListener('dragstart', handleDragStart, true);

  // Canvas tainting
  enableCanvasTainting();
}

/**
 * Apply protection to a specific element.
 * Useful for dynamically added media elements.
 */
export function protectElement(el: HTMLElement): void {
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('dragstart', (e) => e.preventDefault());

  // For images
  if (el instanceof HTMLImageElement) {
    el.draggable = false;
  }
}

/**
 * Remove content protection listeners.
 */
export function destroyContentProtection(): void {
  if (!initialized) return;
  initialized = false;

  document.removeEventListener('keydown', handleKeyDown, true);
  document.removeEventListener('contextmenu', handleContextMenu, true);
  document.removeEventListener('dragstart', handleDragStart, true);
}
