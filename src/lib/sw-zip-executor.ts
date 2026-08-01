import { t } from './i18n.js';
import { executeWvfsZip } from './wvfs-zip-client.js';
import { executeZip } from './zip-executor.js';

export interface SwZipExecutorHandle {
  destroy: () => void;
  postId: string;
}

const SW_SCOPE = '/sw-zip/';
const SW_URL = '/sw-zip/sw.js';
const SW_REGISTER_TIMEOUT = 15000;
const ZIP_READY_TIMEOUT = 90000;
const LOADING_TIMEOUT = 30000;

let activeHandle: SwZipExecutorHandle | null = null;

let swRegistrationPromise: Promise<ServiceWorkerRegistration> | null = null;

function getOrCreateSwReg(): Promise<ServiceWorkerRegistration> {
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  }
  return swRegistrationPromise;
}

function getActiveWorker(): ServiceWorker | null {
  return navigator.serviceWorker.controller?.scriptURL.endsWith(SW_URL) ? navigator.serviceWorker.controller : null;
}

function waitForActiveWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('SWFS: Service Worker activation timeout'));
    }, SW_REGISTER_TIMEOUT);

    const worker = reg.active;
    if (worker) {
      clearTimeout(timeout);
      resolve(worker);
      return;
    }

    const cleanup = () => {
      clearTimeout(timeout);
      reg.removeEventListener('updatefound', onUpdateFound);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };

    const onUpdateFound = () => {
      const w = reg.installing || reg.waiting || reg.active;
      if (w) {
        w.addEventListener('statechange', () => {
          if (w.state === 'activated') {
            cleanup();
            resolve(w);
          }
        });
      }
    };

    const onControllerChange = () => {
      const w = reg.active;
      if (w) {
        cleanup();
        resolve(w);
      }
    };

    reg.addEventListener('updatefound', onUpdateFound);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}

function waitForZipReady(postId: string): Promise<{ fileCount: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('SWFS: ZIP readiness timeout'));
    }, ZIP_READY_TIMEOUT);

    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'SWFS_READY' && event.data.postId === postId) {
        cleanup();
        resolve({ fileCount: event.data.fileCount ?? 0 });
      }
      if (event.data?.type === 'SWFS_ERROR' && event.data.postId === postId) {
        cleanup();
        reject(new Error(event.data.error || 'SWFS: ZIP loading failed'));
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('message', handler);
    };

    navigator.serviceWorker.addEventListener('message', handler);
  });
}

function createLoadingIndicator(): HTMLElement {
  ensureSpinKeyframe();

  const loading = document.createElement('div');
  loading.className = 'sw-zip-loading';
  loading.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--bg-primary, #ffffff);
    z-index: 10;
    transition: opacity 0.3s ease;
    border-radius: 8px;
  `;

  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 32px;
    height: 32px;
    border: 3px solid var(--border, #e2e8f0);
    border-top-color: var(--accent, #22c55e);
    border-radius: 50%;
    animation: sw-zip-spin 0.8s linear infinite;
    margin-bottom: 12px;
  `;

  const text = document.createElement('div');
  text.style.cssText = `
    color: var(--text-muted, #64748b);
    font-size: 0.875rem;
    font-weight: 500;
  `;
  text.textContent = t('post_stage.loading_zip').replace(/<[^>]+>/g, '');

  loading.appendChild(spinner);
  loading.appendChild(text);
  return loading;
}

function ensureSpinKeyframe(): void {
  if (!document.querySelector('#sw-zip-spin-style')) {
    const style = document.createElement('style');
    style.id = 'sw-zip-spin-style';
    style.textContent = `@keyframes sw-zip-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}

function createSandboxIframe(
  postId: string,
  containerEl: HTMLElement,
  hideFullscreen: boolean,
): { iframe: HTMLIFrameElement; cleanup: () => void } {
  const iframeContainer = document.createElement('div');
  iframeContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
  `;

  const iframe = document.createElement('iframe');
  iframe.src = `/sw-zip/${encodeURIComponent(postId)}/index.html`;
  iframe.sandbox = 'allow-scripts allow-pointer-lock allow-fullscreen';
  iframe.setAttribute('allow', 'fullscreen');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    opacity: 0;
    transition: opacity 0.3s ease;
  `;

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.textContent = t('fullscreen.button');
  fullscreenBtn.className = 'sw-zip-fullscreen-btn';
  fullscreenBtn.style.cssText = `
    margin-top: 8px;
    padding: 4px 8px;
    font-size: 12px;
    border: 1px solid #ccc;
    background: #f0f0f0;
    cursor: pointer;
    border-radius: 4px;
    align-self: center;
  `;
  fullscreenBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (iframeContainer.requestFullscreen) {
        iframeContainer.requestFullscreen().catch(() => {
          if (iframe.requestFullscreen) {
            iframe.requestFullscreen().catch(() => {});
          }
        });
      } else if (iframe.requestFullscreen) {
        iframe.requestFullscreen().catch(() => {});
      }
    } catch {
      // ignore
    }
  };

  containerEl.appendChild(iframeContainer);
  iframeContainer.appendChild(iframe);
  if (!hideFullscreen) {
    iframeContainer.appendChild(fullscreenBtn);
  }

  const cleanup = () => {
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  };

  return { iframe, cleanup };
}

function waitForIframeLoad(iframe: HTMLIFrameElement): Promise<boolean> {
  return new Promise((resolve) => {
    if (iframe.contentWindow?.location?.href && iframe.contentWindow.location.href !== 'about:blank') {
      resolve(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      iframe.removeEventListener('load', onLoad);
      resolve(false);
    }, LOADING_TIMEOUT);

    (iframe as HTMLIFrameElement & { _swZipTimeout?: number })._swZipTimeout = timeoutId;

    function onLoad() {
      clearTimeout(timeoutId);
      resolve(true);
    }

    iframe.addEventListener('load', onLoad, { once: true });
  });
}

async function runSwfs(
  postId: string,
  containerEl: HTMLElement,
  fallbackUrl?: string,
  hideFullscreen: boolean = false,
  showLoading: boolean = true,
): Promise<SwZipExecutorHandle> {
  containerEl.innerHTML = '';
  containerEl.style.position = 'relative';

  let loadingEl: HTMLElement | null = null;
  if (showLoading) {
    loadingEl = createLoadingIndicator();
    containerEl.appendChild(loadingEl);
  }

  const reg = await getOrCreateSwReg();
  await navigator.serviceWorker.ready;
  const worker = getActiveWorker() ?? (await waitForActiveWorker(reg));

  const zipUrl = fallbackUrl || `/api/zip/${encodeURIComponent(postId)}`;
  worker.postMessage({ type: 'SWFS_INIT', postId, zipUrl });

  await waitForZipReady(postId);

  const { iframe, cleanup } = createSandboxIframe(postId, containerEl, hideFullscreen);

  const loaded = await waitForIframeLoad(iframe);

  if (loaded) {
    iframe.style.opacity = '1';
    if (loadingEl?.parentNode) {
      loadingEl.style.opacity = '0';
      setTimeout(() => {
        if (loadingEl?.parentNode) loadingEl.remove();
      }, 300);
    }
  } else {
    if (loadingEl?.parentNode) {
      loadingEl.innerHTML = `<div style="color: var(--text-muted, #64748b); text-align: center; padding: 20px; font-size: 0.875rem;">読み込みに時間がかかっています…</div>`;
    }
    iframe.style.opacity = '1';
  }

  const handle: SwZipExecutorHandle = {
    postId,
    destroy: () => {
      clearTimeout((iframe as HTMLIFrameElement & { _swZipTimeout?: number })._swZipTimeout);
      cleanup();
      try {
        worker.postMessage({ type: 'SWFS_CLEANUP', postId });
      } catch {
        // SW might be gone
      }
      if (activeHandle?.postId === postId) {
        activeHandle = null;
      }
    },
  };

  activeHandle = handle;
  return handle;
}

export async function executeSwfsZip(
  postId: string,
  containerEl: HTMLElement,
  fallbackUrl?: string,
  hideFullscreen: boolean = false,
  showLoading: boolean = true,
): Promise<SwZipExecutorHandle> {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    return await runSwfs(postId, containerEl, fallbackUrl, hideFullscreen, showLoading);
  } catch (error) {
    console.warn('SWFS execution failed, falling back to WVFS:', error);
    try {
      const wvfsHandle = await executeWvfsZip(postId, containerEl, undefined, hideFullscreen, showLoading);
      const handle: SwZipExecutorHandle = {
        postId,
        destroy: () => wvfsHandle.destroy(),
      };
      activeHandle = handle;
      return handle;
    } catch (wvfsError) {
      console.warn('WVFS execution failed, falling back to legacy:', wvfsError);
      const legacyHandle = await executeZip(postId, containerEl, fallbackUrl);
      const handle: SwZipExecutorHandle = {
        postId,
        destroy: () => legacyHandle.destroy(),
      };
      activeHandle = handle;
      return handle;
    }
  }
}

// Backwards-compatible alias.
export const executeSwZip = executeSwfsZip;

// Pre-warm: register the SW and load the ZIP into the SWFS cache without
// creating an iframe. Subsequent executeSwfsZip calls are near-instant.
export async function prewarmSwfs(postId: string, fallbackUrl?: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await getOrCreateSwReg();
    await navigator.serviceWorker.ready;
    const worker = getActiveWorker() ?? (await waitForActiveWorker(reg));
    const zipUrl = fallbackUrl || `/api/zip/${encodeURIComponent(postId)}`;
    worker.postMessage({ type: 'SWFS_INIT', postId, zipUrl });
  } catch {
    // Best-effort; game will load on demand.
  }
}
