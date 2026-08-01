/**
 * Capture bridge for Flaxia sandbox games.
 *
 * This script is injected into served game HTML (WVFS ZIP / HTML5 / DOS player)
 * and runs inside the sandbox origin. Because games run in cross-origin iframes
 * without `allow-same-origin`, the parent cannot read the game canvas directly;
 * this bridge captures frames in the sandbox and ships them to the parent via
 * postMessage.
 *
 * It exposes three request/response pairs:
 *  - CAPTURE_INIT        (parent -> game) handshake, starts the rolling buffer
 *  - CAPTURE_READY       (game -> parent) reports whether a canvas was found
 *  - CAPTURE_FRAME       (parent -> game) capture a single PNG frame
 *  - CAPTURE_FRAME_RESULT(game -> parent) PNG frame (ArrayBuffer)
 *  - CAPTURE_GIF         (parent -> game) export the rolling buffer
 *  - CAPTURE_GIF_RESULT  (game -> parent) raw RGBA frames for GIF encoding
 *  - CAPTURE_ERROR       (game -> parent) capture failure
 *
 * All frames are downscaled to a max width and stored in a rolling ring buffer
 * of roughly `BUFFER_MS` seconds so the parent can request "the last N seconds"
 * with a single tap.
 */

const BUFFER_MS = 4000;
const SAMPLE_MS = 150; // ~6.7 fps
const MAX_WIDTH = 360;

// WebGL canvases default to preserveDrawingBuffer:false, which clears the
// drawing buffer once it is composited. Reading pixels (toBlob/drawImage)
// outside the render loop then yields an all-black frame. The bridge runs
// before game scripts (injected at <head>), so we can force the flag on at
// context creation to make captures show the actual game image.
{
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
    options?: any,
  ): RenderingContext | null {
    if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') {
      options = { ...(options as Record<string, unknown> | undefined), preserveDrawingBuffer: true };
    }
    return originalGetContext.call(this, contextId, options);
  } as typeof HTMLCanvasElement.prototype.getContext;
}

interface BufferedFrame {
  ts: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function findGameCanvas(): HTMLCanvasElement | null {
  const selectors = ['#dos-container canvas', '#flash-player canvas', 'canvas'];
  for (const selector of selectors) {
    const els = document.querySelectorAll<HTMLCanvasElement>(selector);
    if (els.length > 0) {
      let best: HTMLCanvasElement | null = null;
      let bestArea = 0;
      for (const el of els) {
        const area = el.width * el.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
      if (best) return best;
    }
  }
  return null;
}

function drawScaled(source: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement | null {
  try {
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    if (!octx) return null;
    octx.drawImage(source, 0, 0, w, h);
    return off;
  } catch {
    return null;
  }
}

function run(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let canvas: HTMLCanvasElement | null = findGameCanvas();
  let parentOrigin: string | null = null;
  let parentWindow: Window | null = null;
  let buffer: BufferedFrame[] = [];
  let sampler: number | null = null;
  let readySent = false;
  let canvasChecker: number | null = null;

  function send(message: Record<string, unknown>, transfer?: Transferable[]): void {
    if (!parentWindow) return;
    // Opaque-origin frames report origin as the literal string "null",
    // which postMessage rejects as a targetOrigin — fall back to '*'.
    const target = parentOrigin === 'null' ? '*' : parentOrigin || '*';
    try {
      parentWindow.postMessage(message, target, transfer);
    } catch {
      try {
        parentWindow.postMessage(message, target);
      } catch {
        // ignore
      }
    }
  }

  function sampleNow(): void {
    if (!canvas) canvas = findGameCanvas();
    if (!canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;

    const scale = Math.min(1, MAX_WIDTH / w);
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));

    const off = drawScaled(canvas, sw, sh);
    if (!off) return;
    const octx = off.getContext('2d');
    if (!octx) return;
    try {
      const image = octx.getImageData(0, 0, sw, sh);
      buffer.push({ ts: performance.now(), width: sw, height: sh, data: image.data });
    } catch {
      // Tainted canvas (e.g. cross-origin images without CORS) — skip frame.
    }

    // Trim frames older than the buffer window.
    const cutoff = performance.now() - BUFFER_MS;
    while (buffer.length > 0 && buffer[0].ts < cutoff) buffer.shift();
  }

  function startSampling(): void {
    if (sampler !== null) return;
    sampleNow();
    sampler = window.setInterval(sampleNow, SAMPLE_MS);
    window.setTimeout(sampleNow, 0);
  }

  function stopSampling(): void {
    if (sampler !== null) {
      window.clearInterval(sampler);
      sampler = null;
    }
  }

  function checkCanvas(): void {
    if (!canvas) canvas = findGameCanvas();
    if (canvas && !readySent) {
      readySent = true;
      startSampling();
      send({ type: 'CAPTURE_READY', ok: true });
      if (canvasChecker !== null) {
        window.clearInterval(canvasChecker);
        canvasChecker = null;
      }
    }
  }

  function handleReadyInit(): void {
    canvas = findGameCanvas();
    if (canvas) {
      readySent = true;
      startSampling();
    } else if (canvasChecker === null) {
      // Games (especially DOS) may create their canvas after boot; poll for it.
      canvasChecker = window.setInterval(checkCanvas, 500);
      window.setTimeout(() => {
        if (canvasChecker !== null) {
          window.clearInterval(canvasChecker);
          canvasChecker = null;
        }
      }, 30000);
    }
  }

  function requestFrame(requestId: string): void {
    const c = canvas || findGameCanvas();
    if (!c) {
      send({ type: 'CAPTURE_ERROR', requestId, message: 'no-canvas' });
      return;
    }
    try {
      c.toBlob((blob) => {
        if (!blob) {
          send({ type: 'CAPTURE_ERROR', requestId, message: 'toBlob-failed' });
          return;
        }
        blob.arrayBuffer().then(
          (data) => {
            send({ type: 'CAPTURE_FRAME_RESULT', requestId, mime: blob.type || 'image/png', data }, [data]);
          },
          () => {
            send({ type: 'CAPTURE_ERROR', requestId, message: 'arrayBuffer-failed' });
          },
        );
      }, 'image/png');
    } catch (error) {
      send({
        type: 'CAPTURE_ERROR',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function requestGif(requestId: string): void {
    if (buffer.length === 0) {
      send({ type: 'CAPTURE_ERROR', requestId, message: 'no-frames' });
      return;
    }
    const frames = buffer.map((f) => ({
      width: f.width,
      height: f.height,
      ts: f.ts,
      data: f.data.slice().buffer,
    }));
    buffer = [];
    send(
      { type: 'CAPTURE_GIF_RESULT', requestId, frames },
      frames.map((f) => f.data as ArrayBuffer),
    );
  }

  function handleMessage(event: MessageEvent): void {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const type = typeof data.type === 'string' ? data.type : '';

    // Only accept commands from the parent that initiated the handshake,
    // or the initial handshake itself.
    if (type === 'CAPTURE_INIT') {
      parentOrigin = event.origin || '*';
      parentWindow = event.source as Window | null;
      handleReadyInit();
      send({ type: 'CAPTURE_READY', ok: !!canvas });
      return;
    }

    if (parentWindow && event.source !== parentWindow) return;

    switch (type) {
      case 'CAPTURE_FRAME':
        requestFrame(typeof data.requestId === 'string' ? data.requestId : '');
        break;
      case 'CAPTURE_GIF':
        requestGif(typeof data.requestId === 'string' ? data.requestId : '');
        break;
    }
  }

  window.addEventListener('message', handleMessage);
  window.addEventListener('pagehide', stopSampling);

  const existing = (window as unknown as Record<string, unknown>).__FLAXIA_CAPTURE__;
  if (!existing) {
    (window as unknown as Record<string, unknown>).__FLAXIA_CAPTURE__ = {
      findCanvas: () => findGameCanvas(),
    };
  }
}

run();
