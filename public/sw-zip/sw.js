importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const EXT_CONFIG = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.unityweb': 'application/octet-stream',
  '.wasm.code': 'application/wasm',
  '.wasm.framework': 'application/octet-stream',
  '.txt': 'text/plain',
  '.glsl': 'text/plain',
  '.wgsl': 'text/plain',
  '.rsp': 'text/plain',
  '.exe': 'application/x-msdos-program',
  '.com': 'application/x-msdos-program',
  '.bat': 'text/plain',
  '.conf': 'text/plain',
  '.cfg': 'text/plain',
  '.cf': 'text/plain',
  '.img': 'application/octet-stream',
  '.iso': 'application/x-iso9660',
  '.dosz': 'application/octet-stream',
  '.zip': 'application/zip',
  '.jsdos': 'application/zip',
  '.ovl': 'application/octet-stream',
  '.db': 'application/x-sqlite3',
};

const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const MAX_FILE_COUNT = 255;
const MAX_PATH_DEPTH = 10;
const MEMORY_TTL = 30 * 60 * 1000;
const MEMORY_BUDGET = 150 * 1024 * 1024;
const ZIP_FETCH_TIMEOUT = 60000;

const CACHE_NAME = 'flaxia-swfs-v1';
const ZIP_CACHE_PREFIX = 'swfs-zip:';
const FILE_CACHE_PREFIX = 'swfs-file:';

// In-memory stores keyed by postId.
// store: { index: Map<string, entry>, files: Map<string, Uint8Array>, zipBytes: Uint8Array|null, zipUrl: string, createdAt, lastAccess }
const zipStores = new Map();

// Dedupe concurrent init/fetch for the same postId.
const initPromises = new Map();

function cleanupExpired() {
  const now = Date.now();
  for (const [postId, store] of zipStores) {
    if (now - store.lastAccess > MEMORY_TTL) {
      zipStores.delete(postId);
    }
  }
}

function enforceMemoryBudget() {
  let total = 0;
  for (const store of zipStores.values()) {
    total += store.zipBytes ? store.zipBytes.byteLength : 0;
    for (const data of store.files.values()) {
      total += data.byteLength;
    }
  }
  if (total <= MEMORY_BUDGET) return;

  const entries = [...zipStores.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [postId] of entries) {
    zipStores.delete(postId);
    if (total <= MEMORY_BUDGET) break;
  }
}

// ---- ZIP central directory parsing (port of wvfs-zip-server) ----

function readUint16(view, offset) {
  return view.getUint16(offset, true);
}

function readUint32(view, offset) {
  return view.getUint32(offset, true);
}

function findEocd(data) {
  for (let i = data.length - 22; i >= 0; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      const view = new DataView(data.buffer, data.byteOffset + i);
      return {
        cdEntries: readUint16(view, 8),
        cdSize: readUint32(view, 12),
        cdOffset: readUint32(view, 16),
      };
    }
  }
  return null;
}

function isValidExtension(filename) {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return ext in EXT_CONFIG;
}

// Parse + validate the central directory. Builds name -> entry index.
function buildZipIndex(zipBytes) {
  const eocd = findEocd(zipBytes);
  if (!eocd) {
    throw new Error('Invalid ZIP: end of central directory not found');
  }
  const cdEnd = eocd.cdOffset + eocd.cdSize;
  if (cdEnd > zipBytes.length) {
    throw new Error('Invalid ZIP: central directory out of bounds');
  }
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset);
  const index = new Map();
  let offset = eocd.cdOffset;
  let entryCount = 0;
  let totalSize = 0;
  let hasIndexHtml = false;

  while (offset + 46 <= cdEnd) {
    if (readUint32(view, offset) !== 0x02014b50) break;

    const fileNameLen = readUint16(view, offset + 28);
    const extraLen = readUint16(view, offset + 30);
    const commentLen = readUint16(view, offset + 32);

    entryCount++;
    if (entryCount > MAX_FILE_COUNT) {
      throw new Error('Too many files (max ' + MAX_FILE_COUNT + ')');
    }

    const fileNameBytes = zipBytes.slice(offset + 46, offset + 46 + fileNameLen);
    const fileName = new TextDecoder().decode(fileNameBytes);

    if (!fileName.endsWith('/')) {
      if (fileName.length > 255) {
        throw new Error('Path too long: ' + fileName);
      }
      const depth = (fileName.match(/\//g) || []).length;
      if (depth > MAX_PATH_DEPTH) {
        throw new Error('Directory too deep: ' + fileName);
      }
      if (fileName.includes('../')) {
        throw new Error('Path traversal detected: ' + fileName);
      }
      if (fileName.startsWith('/')) {
        throw new Error('Absolute paths are not allowed: ' + fileName);
      }

      const uncompressedSize = readUint32(view, offset + 24);
      if (uncompressedSize === 0xffffffff) {
        throw new Error('ZIP64 archives are not supported');
      }

      const externalAttrs = readUint32(view, offset + 38);
      if (((externalAttrs >>> 16) & 0xf000) === 0xa000) {
        throw new Error('Symbolic links are not allowed');
      }

      const normalizedName = fileName.replace(/^(\.\/)+/, '');
      if (!normalizedName) {
        offset += 46 + fileNameLen + extraLen + commentLen;
        continue;
      }
      if (normalizedName.toLowerCase().endsWith('.zip')) {
        throw new Error('Nested ZIP files are not allowed');
      }
      if (!isValidExtension(normalizedName)) {
        throw new Error('File type not allowed: ' + normalizedName);
      }

      const fileNamePart = normalizedName.split('/').pop().toLowerCase();
      if (fileNamePart === 'index.html' || fileNamePart === 'index.htm') {
        hasIndexHtml = true;
      }

      totalSize += uncompressedSize;
      if (totalSize > MAX_TOTAL_SIZE) {
        throw new Error('Extracted size too large (max 100MB)');
      }

      index.set(normalizedName, {
        fileName: normalizedName,
        localHeaderOffset: readUint32(view, offset + 42),
        compressedSize: readUint32(view, offset + 20),
        uncompressedSize,
        compressionMethod: readUint16(view, offset + 10),
      });
    }

    offset += 46 + fileNameLen + extraLen + commentLen;
  }

  if (!hasIndexHtml) {
    throw new Error('index.html not found in zip');
  }

  return index;
}

// Extract a single entry from in-memory ZIP bytes (inflate only that file).
function extractFileFromZip(zipBytes, entry) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset);
  const lho = entry.localHeaderOffset;

  if (lho + 30 > zipBytes.length || readUint32(view, lho) !== 0x04034b50) {
    return null;
  }

  const fileNameLen = readUint16(view, lho + 26);
  const extraLen = readUint16(view, lho + 28);
  const dataOffset = lho + 30 + fileNameLen + extraLen;

  if (dataOffset + entry.compressedSize > zipBytes.length) {
    return null;
  }

  const compressed = zipBytes.slice(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    return fflate.inflateSync(compressed);
  }
  return null;
}

// ---- Path resolution (mirrors wvfs-zip-server) ----

function normalizePath(path) {
  if (!path) return 'index.html';
  const segments = path.replace(/^\//, '').split('/');
  const normalized = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
    } else if (segment === '..') {
      if (normalized.length === 0) {
        throw new Error('Path traversal detected: attempt to go beyond root directory');
      }
      normalized.pop();
    } else {
      if (segment.includes('\0') || /[<>:"|?*]/.test(segment)) {
        throw new Error('Invalid path segment: ' + segment);
      }
      if (segment.length > 255) {
        throw new Error('Path segment too long: ' + segment);
      }
      normalized.push(segment);
    }
  }
  if (normalized.length > MAX_PATH_DEPTH) {
    throw new Error('Path too deep: ' + normalized.join('/'));
  }
  const result = normalized.join('/');
  return result || 'index.html';
}

function findFileInIndex(index, filePath) {
  let entry = index.get(filePath);
  if (entry) return { entry, path: filePath };

  if (filePath.endsWith('/')) {
    const withIndex = filePath + 'index.html';
    entry = index.get(withIndex);
    if (entry) return { entry, path: withIndex };
  }

  if (filePath.startsWith('/')) {
    const stripped = filePath.substring(1);
    entry = index.get(stripped);
    if (entry) return { entry, path: stripped };
  }

  const fallbacks = [filePath + '/index.html', filePath.replace(/\/$/, '')];
  for (const fallback of fallbacks) {
    entry = index.get(fallback);
    if (entry) return { entry, path: fallback };
  }

  if (!filePath.startsWith('./')) {
    entry = index.get('./' + filePath);
    if (entry) return { entry, path: './' + filePath };
  }

  return null;
}

function findSubdirIndexInIndex(index) {
  let bestKey = null;
  let bestDepth = Infinity;
  for (const key of index.keys()) {
    const parts = key.split('/');
    const fileName = parts.pop().toLowerCase();
    if (fileName === 'index.html' || fileName === 'index.htm') {
      const depth = parts.length;
      if (depth < bestDepth) {
        bestDepth = depth;
        bestKey = key;
      }
    }
  }
  return bestKey;
}

function resolveEntry(index, filePath) {
  const normalizedPath = normalizePath(filePath);
  let resolved = findFileInIndex(index, normalizedPath);

  if (!resolved) {
    const fileName = normalizedPath.split('/').pop().toLowerCase();
    if (fileName === 'index.html' || fileName === 'index.htm') {
      const foundPath = findSubdirIndexInIndex(index);
      if (foundPath) {
        const entry = index.get(foundPath);
        if (entry) resolved = { entry, path: foundPath };
      }
    }
  }

  return resolved;
}

// ---- Cache Storage helpers ----

async function openCache() {
  return caches.open(CACHE_NAME);
}

async function getCachedZip(postId) {
  const cache = await openCache();
  const res = await cache.match(ZIP_CACHE_PREFIX + postId);
  if (!res) return null;
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function putCachedZip(postId, zipBytes) {
  const cache = await openCache();
  await cache.put(
    ZIP_CACHE_PREFIX + postId,
    new Response(zipBytes, { headers: { 'Content-Type': 'application/octet-stream' } }),
  );
}

async function getCachedFile(postId, path) {
  const cache = await openCache();
  const res = await cache.match(FILE_CACHE_PREFIX + postId + ':' + path);
  if (!res) return null;
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function putCachedFile(postId, path, data) {
  const cache = await openCache();
  await cache.put(
    FILE_CACHE_PREFIX + postId + ':' + path,
    new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } }),
  );
}

async function deletePostCache(postId) {
  const cache = await openCache();
  const keys = await cache.keys();
  const zipKey = ZIP_CACHE_PREFIX + postId;
  const filePrefix = FILE_CACHE_PREFIX + postId + ':';
  const toDelete = keys.filter((k) => k.url === zipKey || k.url.startsWith(filePrefix));
  await Promise.all(toDelete.map((k) => cache.delete(k)));
}

// ---- Lifecycle ----

function getDefaultZipUrl(postId) {
  return '/api/zip/' + encodeURIComponent(postId);
}

async function loadZip(postId, zipUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZIP_FETCH_TIMEOUT);
  try {
    const res = await fetch(zipUrl, { signal: controller.signal, credentials: 'omit' });
    if (!res.ok) {
      throw new Error('ZIP fetch failed: ' + res.status);
    }
    const buf = await res.arrayBuffer();
    const zipBytes = new Uint8Array(buf);
    if (zipBytes.byteLength > MAX_TOTAL_SIZE) {
      throw new Error('ZIP file exceeds size limit');
    }
    const index = buildZipIndex(zipBytes);
    return { zipBytes, index };
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureStore(postId, zipUrl) {
  cleanupExpired();

  const existing = zipStores.get(postId);
  if (existing && existing.index) {
    existing.lastAccess = Date.now();
    return existing;
  }

  if (initPromises.has(postId)) {
    return initPromises.get(postId);
  }

  const promise = (async () => {
    const cachedZip = await getCachedZip(postId);
    let store;

    if (cachedZip) {
      const index = buildZipIndex(cachedZip);
      store = {
        index,
        files: new Map(),
        zipBytes: cachedZip,
        zipUrl: zipUrl || getDefaultZipUrl(postId),
        createdAt: Date.now(),
        lastAccess: Date.now(),
      };
    } else {
      const loaded = await loadZip(postId, zipUrl || getDefaultZipUrl(postId));
      store = {
        index: loaded.index,
        files: new Map(),
        zipBytes: loaded.zipBytes,
        zipUrl: zipUrl || getDefaultZipUrl(postId),
        createdAt: Date.now(),
        lastAccess: Date.now(),
      };
      await putCachedZip(postId, loaded.zipBytes);
    }

    zipStores.set(postId, store);
    enforceMemoryBudget();
    return store;
  })();

  initPromises.set(postId, promise);
  try {
    return await promise;
  } finally {
    initPromises.delete(postId);
  }
}

async function serveFromStore(postId, filePath, store) {
  const resolved = resolveEntry(store.index, filePath);
  if (!resolved) return null;

  const { entry, path: resolvedPath } = resolved;
  store.lastAccess = Date.now();

  let data = store.files.get(resolvedPath);
  if (!data) {
    data = await getCachedFile(postId, resolvedPath);
  }
  if (!data) {
    if (!store.zipBytes) {
      const cachedZip = await getCachedZip(postId);
      if (cachedZip) {
        store.zipBytes = cachedZip;
        store.index = buildZipIndex(cachedZip);
      }
    }
    if (store.zipBytes) {
      data = extractFileFromZip(store.zipBytes, entry);
      if (data) {
        store.files.set(resolvedPath, data);
        await putCachedFile(postId, resolvedPath, data);
      }
    }
  }

  if (!data) return null;

  const ext = resolvedPath.split('.').pop().toLowerCase();
  const contentType = EXT_CONFIG['.' + ext] || 'application/octet-stream';

  if (ext === 'html' || ext === 'htm') {
    const html = new TextDecoder().decode(data);
    const baseSubPath = resolvedPath.includes('/') ? resolvedPath.substring(0, resolvedPath.lastIndexOf('/') + 1) : '';
    const baseHref = '/sw-zip/' + postId + '/' + baseSubPath;
    const withoutCsp = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi, '');
    const rewritten = rewriteLocalAbsolutePaths(withoutCsp);
    const modified = rewritten.includes('<head>')
      ? rewritten.replace('<head>', '<head>\n  <base href="' + baseHref + '">')
      : rewritten.includes('<meta charset')
        ? rewritten.replace(/(<meta charset[^>]*>)/i, '$1\n  <base href="' + baseHref + '">')
        : '<base href="' + baseHref + '">\n' + rewritten;
    data = new TextEncoder().encode(modified);
  }

  return new Response(data, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    },
  });
}

function rewriteLocalAbsolutePaths(htmlContent) {
  htmlContent = htmlContent.replace(/(?:(?:src|href)\s*=\s*['"])(\/[^'"]+)(['"])/gi, (match, path, quote) => {
    if (
      path.startsWith('/') &&
      !path.startsWith('//') &&
      !path.startsWith('/https:') &&
      !path.startsWith('/http:') &&
      !path.startsWith('/data:') &&
      !path.startsWith('/blob:') &&
      !path.startsWith('/mailto:') &&
      !path.startsWith('/tel:')
    ) {
      return match.replace(path, path.substring(1));
    }
    return match;
  });

  htmlContent = htmlContent.replace(/srcset\s*=\s*['"]([^'"]+)['"]/gi, (match, value) => {
    const newValue = value.split(',').map((part) => {
      const trimmed = part.trim();
      const [url, ...descriptor] = trimmed.split(/\s+/);
      if (
        url.startsWith('/') &&
        !url.startsWith('//') &&
        !url.startsWith('/https:') &&
        !url.startsWith('/http:') &&
        !url.startsWith('/data:') &&
        !url.startsWith('/blob:')
      ) {
        return [url.substring(1), ...descriptor].join(' ');
      }
      return trimmed;
    });
    return 'srcset="' + newValue + '"';
  });

  htmlContent = htmlContent.replace(/url\(\s*['"]?\/([^'")\s]+)['"]?\s*\)/gi, (match, path) => {
    if (
      !path.startsWith('/') &&
      !path.startsWith('//') &&
      !path.startsWith('https:') &&
      !path.startsWith('http:') &&
      !path.startsWith('data:') &&
      !path.startsWith('blob:')
    ) {
      return 'url("' + path + '")';
    }
    return match;
  });

  return htmlContent;
}

// ---- SW event handlers ----

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const { type, postId } = event.data || {};
  if (!postId) return;

  if (type === 'SWFS_INIT') {
    const { zipUrl } = event.data;
    ensureStore(postId, zipUrl)
      .then((store) => {
        event.source?.postMessage({ type: 'SWFS_READY', postId, fileCount: store.index.size });
      })
      .catch((err) => {
        event.source?.postMessage({ type: 'SWFS_ERROR', postId, error: err.message || String(err) });
      });
  } else if (type === 'SWFS_CLEANUP') {
    zipStores.delete(postId);
    deletePostCache(postId).catch(() => {});
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/sw-zip\/([^/]+)(\/.*)?$/);
  if (!match) return;

  const postId = decodeURIComponent(match[1]);
  let filePath = match[2] || '/index.html';
  if (filePath === '/') filePath = '/index.html';

  event.respondWith(
    (async () => {
      try {
        const store = await ensureStore(postId, null);
        const response = await serveFromStore(postId, filePath, store);
        if (response) return response;
        return new Response('404 Not Found: ' + filePath, { status: 404, headers: { 'Content-Type': 'text/plain' } });
      } catch (err) {
        return new Response('SWFS error: ' + (err.message || String(err)), {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    })(),
  );
});
