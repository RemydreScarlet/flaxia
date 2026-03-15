let cachedMe: any = null
let cachePromise: Promise<any> | null = null

export async function getMe(): Promise<any> {
  // すでにキャッシュがあればそのまま返す
  if (cachedMe) return cachedMe

  // 既にfetch中なら同じPromiseを返す（重複リクエスト防止）
  if (cachePromise) return cachePromise

  cachePromise = fetch('/api/me')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      cachedMe = data
      cachePromise = null
      return data
    })
    .catch(() => {
      cachePromise = null
      return null
    })

  return cachePromise
}

export function clearMeCache() {
  cachedMe = null
  cachePromise = null
}

export function updateMeCache(data: any) {
  cachedMe = data
}
