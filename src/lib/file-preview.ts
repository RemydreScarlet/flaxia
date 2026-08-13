import { createAudioPlayer } from '../components/AudioPlayer.js';
import { executeDos } from '../components/DosPlayer.js';
import { executeFlash } from '../components/FlashPlayer.js';
import { createVideoPlayer } from '../components/VideoPlayer.js';
import { t } from './i18n.js';
import { detectZipType } from './zip-type.js';

export type AttachPreviewKind = 'image' | 'audio' | 'video' | 'game';

export interface AttachPreviewHandle {
  destroy: () => void;
}

export function detectAttachKind(file: File): AttachPreviewKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.gif') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image';
  }
  if (name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.ogg') || name.endsWith('.m4a')) {
    return 'audio';
  }
  if (name.endsWith('.webm') || name.endsWith('.mp4') || name.endsWith('.mov')) {
    return 'video';
  }
  if (name.endsWith('.zip') || name.endsWith('.jsdos') || name.endsWith('.swf')) {
    return 'game';
  }
  return null;
}

/**
 * Renders an inline preview of a selected attachment inside the composer's
 * file preview area. Images, audio and video are shown as compact inline
 * media; games (.zip / .jsdos / .swf) render as a chip with a play button that
 * executes the game once clicked.
 */
export function renderFilePreview(
  file: File,
  previewContainer: HTMLElement,
  getZipType: () => 'html5' | 'dos' | null,
): AttachPreviewHandle {
  const kind = detectAttachKind(file);

  const body = document.createElement('div');
  body.className = 'file-preview-body';

  const revokeUrls: Array<() => void> = [];
  let gameHandle: { destroy: () => void } | null = null;

  if (kind === 'image') {
    const url = URL.createObjectURL(file);
    revokeUrls.push(() => URL.revokeObjectURL(url));
    const img = document.createElement('img');
    img.className = 'file-preview-image';
    img.src = url;
    img.alt = file.name;
    body.appendChild(img);
  } else if (kind === 'audio') {
    const url = URL.createObjectURL(file);
    revokeUrls.push(() => URL.revokeObjectURL(url));
    const wrap = document.createElement('div');
    wrap.className = 'file-preview-media file-preview-media--audio';
    const player = createAudioPlayer({ gifKey: '', postId: 'preview', src: url });
    wrap.appendChild(player);
    body.appendChild(wrap);
  } else if (kind === 'video') {
    const url = URL.createObjectURL(file);
    revokeUrls.push(() => URL.revokeObjectURL(url));
    const wrap = document.createElement('div');
    wrap.className = 'file-preview-media file-preview-media--video';
    const player = createVideoPlayer({ gifKey: '', postId: 'preview', src: url });
    wrap.appendChild(player);
    body.appendChild(wrap);
  } else if (kind === 'game') {
    const gameStage = document.createElement('div');
    gameStage.className = 'file-preview-game-stage';
    gameStage.style.display = 'none';
    const ext = file.name.toLowerCase().split('.').pop() || '';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'file-preview-game-play';
    playBtn.textContent = t('composer.preview_play');

    playBtn.addEventListener('click', () => {
      playBtn.disabled = true;
      playBtn.textContent = t('composer.preview_playing');
      gameStage.style.display = 'block';
      if (ext === 'swf') {
        void (async () => {
          try {
            const data = await file.arrayBuffer();
            gameHandle = await executeFlash('preview', gameStage, undefined, true, data);
          } catch (error) {
            console.error('Failed to preview SWF:', error);
            showGameError(gameStage, error);
          }
        })();
        return;
      }
      let type = getZipType();
      if (!type && ext === 'zip') {
        void detectZipType(file).then(async (detected) => {
          type = detected;
          await runGame(file, type, ext, gameStage, (h) => (gameHandle = h));
        });
        return;
      }
      void runGame(file, type, ext, gameStage, (h) => (gameHandle = h));
    });

    const chipIcon = document.createElement('span');
    chipIcon.className = 'file-preview-game-icon';
    chipIcon.textContent = ext === 'swf' ? '⚡' : '🕹️';

    const chip = document.createElement('div');
    chip.className = 'file-preview-game-chip';
    chip.appendChild(chipIcon);
    chip.appendChild(playBtn);

    body.appendChild(chip);
    body.appendChild(gameStage);
  } else {
    const text = document.createElement('div');
    text.className = 'file-preview-plain';
    text.textContent = `${file.name} (${formatPreviewSize(file.size)})`;
    body.appendChild(text);
  }

  previewContainer.appendChild(body);

  return {
    destroy: () => {
      for (const fn of revokeUrls) fn();
      if (gameHandle) {
        try {
          gameHandle.destroy();
        } catch {
          /* ignore */
        }
      }
      body.remove();
    },
  };
}

async function runGame(
  file: File,
  type: 'html5' | 'dos' | null,
  ext: string,
  gameStage: HTMLElement,
  storeHandle: (h: { destroy: () => void }) => void,
): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    if (type === 'dos' || ext === 'jsdos') {
      storeHandle(await executeDos('preview', gameStage, url, true));
    } else {
      storeHandle(await executeZipPreview(file, gameStage, url));
    }
  } catch (error) {
    console.error('Failed to preview game:', error);
    showGameError(gameStage, error);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function executeZipPreview(file: File, gameStage: HTMLElement, url: string): Promise<{ destroy: () => void }> {
  const { executeZip } = await import('./zip-executor.js');
  return executeZip('preview', gameStage, url);
}

function showGameError(gameStage: HTMLElement, error: unknown): void {
  gameStage.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 20px;
      text-align: center;
      color: var(--text-muted, #64748b);
      font-size: 0.875rem;
    ">
      <div>${t('composer.preview_play_failed')}</div>
      <div style="font-size: 0.75rem; margin-top: 4px;">${error instanceof Error ? error.message : ''}</div>
    </div>
  `;
}

function formatPreviewSize(bytes: number): string {
  if (bytes < 1024) return t('file_size.bytes', { size: bytes });
  if (bytes < 1024 * 1024) return t('file_size.kb', { size: (bytes / 1024).toFixed(1) });
  return t('file_size.mb', { size: (bytes / (1024 * 1024)).toFixed(1) });
}
