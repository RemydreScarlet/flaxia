import { Hono } from 'hono'
import { cors } from 'hono/cors'

interface Env {
  BUCKET: R2Bucket
}

type Bindings = Env

const app = new Hono<{ Bindings: Bindings }>()

// CORS for sandbox
app.use('/*', cors({
  origin: ['https://flaxia.app', 'https://*.pages.dev'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}))

// Service Worker script
app.get('/sw.js', async (c) => {
  const swContent = `console.log('Service Worker script loading...')

importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js')

console.log('fflate loaded:', typeof fflate !== 'undefined')

// 仮想ファイルシステム: path → Uint8Array
const virtualFS = new Map()
let fsReady = false

self.addEventListener('install', () => {
  console.log('Service Worker installing')
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  console.log('Service Worker activating')
  e.waitUntil(self.clients.claim())
})

// --- ZIP 受信 & 展開 ---
self.addEventListener('message', (event) => {
  console.log('Message received:', event.data?.type)
  
  if (event.data?.type !== 'SETUP_ZIP') return

  console.log('Processing ZIP data...')
  const zipData = new Uint8Array(event.data.zipData)
  console.log('ZIP data size:', zipData.byteLength)

  try {
    // fflate で同期展開
    console.log('Starting ZIP extraction...')
    const files = fflate.unzipSync(zipData)
    console.log('ZIP extracted, files:', Object.keys(files).length)

    virtualFS.clear()
    for (const [path, data] of Object.entries(files)) {
      // ディレクトリエントリを除外
      if (!path.endsWith('/')) {
        virtualFS.set('/' + path, data)
      }
    }
    fsReady = true

    // 全クライアントに通知
    self.clients.matchAll().then(clients =>
      clients.forEach(c => c.postMessage({
        type: 'ZIP_READY',
        fileCount: virtualFS.size,
        files: [...virtualFS.keys()]
      }))
    )
  } catch (err) {
    self.clients.matchAll().then(clients =>
      clients.forEach(c => c.postMessage({
        type: 'ZIP_ERROR',
        error: err.message
      }))
    )
  }
})

// --- fetch インターセプト ---
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // /sandbox/post/* 配下のリクエストのみ仮想FSで処理
  const match = url.pathname.match(/^\/sandbox\/post\/[^\/]+(\/.*)?$/)
  if (!match) return  // 他はスルー

  // sandbox内パス: /sandbox/post/{id}/foo/bar → /foo/bar
  let filePath = match[1] || '/index.html'
  if (filePath === '/') filePath = '/index.html'
  
  // 親ページリクエスト (/sandbox/post/{id}) はスルーして Worker に処理させる
  if (!match[1]) return

  event.respondWith(serveFromFS(filePath))
})

async function serveFromFS(filePath) {
  // FSが未準備の場合は最大3秒待機
  if (!fsReady) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FS timeout')), 3000)
      const check = setInterval(() => {
        if (fsReady) { clearInterval(check); clearTimeout(timer); resolve() }
      }, 50)
    }).catch(() => {})
  }

  const data = virtualFS.get(filePath)
    ?? virtualFS.get(filePath.replace(/\/$/, '/index.html'))

  if (!data) {
    return new Response('404 Not Found: ' + filePath, {
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    })
  }

  return new Response(data, {
    headers: {
      'Content-Type': getMime(filePath),
      'Cache-Control': 'no-cache'
    }
  })
}

function getMime(path) {
  const ext = path.split('.').pop().toLowerCase()
  const map = {
    html:'text/html', css:'text/css',
    js:'text/javascript', mjs:'text/javascript',
    json:'application/json', svg:'image/svg+xml',
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
    gif:'image/gif', ico:'image/x-icon',
    woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf',
    webp:'image/webp', mp4:'video/mp4', webm:'video/webm',
    mp3:'audio/mpeg', wav:'audio/wav',wasm:'application/wasm'
  }
  return map[ext] ?? 'application/octet-stream'
}`
  
  return new Response(swContent, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/sandbox/'
    }
  })
})

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx)
  }
}
