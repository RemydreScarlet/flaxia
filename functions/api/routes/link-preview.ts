import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';

const link = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Helper functions for link preview
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function parseMetaTags(html: string, baseUrl: string) {
  const result = {
    title: '',
    description: '',
    image: '',
    siteName: '',
    url: baseUrl,
    type: '',
    video: {
      url: '',
      secureUrl: '',
      type: '',
      width: 0,
      height: 0,
    },
  };

  const matchMeta = (property: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const matchMetaName = (name: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const resolveUrl = (url: string): string => {
    if (url.startsWith('//')) {
      try {
        return new URL(url, baseUrl).toString();
      } catch {}
    } else if (url.startsWith('/') || url.startsWith('.')) {
      try {
        return new URL(url, baseUrl).toString();
      } catch {}
    }
    return url;
  };

  // 1. Title
  const ogTitle = matchMeta('og:title') || matchMetaName('twitter:title');
  if (ogTitle) {
    result.title = decodeHtmlEntities(ogTitle);
  } else {
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag) {
      result.title = decodeHtmlEntities(titleTag[1].trim());
    }
  }

  // 2. Description
  const ogDesc = matchMeta('og:description') || matchMetaName('description') || matchMetaName('twitter:description');
  if (ogDesc) {
    result.description = decodeHtmlEntities(ogDesc);
  }

  // 3. Image
  const ogImage = matchMeta('og:image') || matchMetaName('twitter:image');
  if (ogImage) {
    result.image = resolveUrl(ogImage);
  }

  // 4. Site Name
  const ogSiteName = matchMeta('og:site_name');
  if (ogSiteName) {
    result.siteName = decodeHtmlEntities(ogSiteName);
  } else {
    try {
      result.siteName = new URL(baseUrl).hostname;
    } catch {}
  }

  // 5. og:type
  const ogType = matchMeta('og:type');
  if (ogType) {
    result.type = ogType;
  }

  // 6. Video embed info
  const ogVideoUrl = matchMeta('og:video:url') || matchMeta('og:video');
  const ogVideoSecureUrl = matchMeta('og:video:secure_url');
  const ogVideoType = matchMeta('og:video:type');
  const ogVideoWidth = matchMeta('og:video:width');
  const ogVideoHeight = matchMeta('og:video:height');

  if (ogVideoUrl) {
    result.video.url = resolveUrl(ogVideoUrl);
  }
  if (ogVideoSecureUrl) {
    result.video.secureUrl = ogVideoSecureUrl;
  }
  if (ogVideoType) {
    result.video.type = ogVideoType;
  }
  if (ogVideoWidth) {
    result.video.width = parseInt(ogVideoWidth, 10) || 0;
  }
  if (ogVideoHeight) {
    result.video.height = parseInt(ogVideoHeight, 10) || 0;
  }

  return result;
}

function isPrivateIP(hostname: string): boolean {
  // IPv4
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]].map(Number);
    if (octets.some((o) => o > 255)) return true;
    const [a, b] = octets;
    // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10 (CGNAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 198.18.0.0/15
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  // IPv6
  if (hostname.includes(':') && hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.includes(':')) {
    const normalized = hostname.toLowerCase();
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  }
  return false;
}

function isInternalHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase();
  // Strip trailing dot for FQDN
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  const internalNames = new Set([
    'localhost',
    'localhost.localdomain',
    'local',
    'broadcasthost',
    'metadata.google.internal',
    'metadata',
    '169.254.169.254',
  ]);
  if (internalNames.has(name)) return name;
  // Block any hostname ending in .internal, .local, .localhost
  if (name.endsWith('.internal') || name.endsWith('.local') || name.endsWith('.localhost')) return name;
  return null;
}

function checkSSRF(url: URL): string | null {
  const hostname = url.hostname;
  // Strip brackets from IPv6
  const cleanHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isPrivateIP(cleanHost)) return 'Requests to private IP addresses are not allowed';
  const internal = isInternalHostname(hostname);
  if (internal) return `Requests to ${internal} are not allowed`;
  return null;
}

// GET /api/link-preview - Scrape OpenGraph meta tags of a URL
link.get('/link-preview', async (c) => {
  const urlString = c.req.query('url');
  if (!urlString) {
    return c.json({ error: 'Missing url parameter' }, 400);
  }

  try {
    const targetUrl = new URL(urlString);
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return c.json({ error: 'Invalid protocol' }, 400);
    }

    const blockedHost = checkSSRF(targetUrl);
    if (blockedHost) {
      return c.json({ error: blockedHost }, 400);
    }

    const response = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FlaxiaPreviewBot/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return c.json({
        title: targetUrl.hostname,
        description: '',
        image: '',
        siteName: targetUrl.hostname,
        url: targetUrl.toString(),
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return c.json({
        title: targetUrl.pathname.split('/').pop() || targetUrl.hostname,
        description: '',
        image: contentType.startsWith('image/') ? targetUrl.toString() : '',
        siteName: targetUrl.hostname,
        url: targetUrl.toString(),
      });
    }

    const reader = response.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let bytesRead = 0;
      const maxBytes = 256 * 1024; // 256KB

      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesRead += value.length;
          html += decoder.decode(value, { stream: true });
        }
      }
      html += decoder.decode();
    } else {
      html = await response.text();
    }

    const previewData = parseMetaTags(html, targetUrl.toString());
    return c.json(previewData);
  } catch (error: unknown) {
    console.error('Link preview error:', error);
    return c.json({ error: 'Failed to fetch link preview' }, 500);
  }
});

export default link;
