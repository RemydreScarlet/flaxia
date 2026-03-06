interface CloudflareAccessIdentity {
  sub: string
  email: string
  name?: string
}

export async function verifyCloudflareAccess(
  request: Request,
  env: any
): Promise<CloudflareAccessIdentity | null> {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') ||
               getCookieFromRequest(request, 'CF_Authorization')
  
  if (!jwt) return null
  
  try {
    // For MVP, we'll decode the JWT without verification
    // In production, verify against Cloudflare's JWKS
    const payload = JSON.parse(atob(jwt.split('.')[1]))
    
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name
    }
  } catch (error) {
    console.error('JWT verification failed:', error)
    return null
  }
}

function getCookieFromRequest(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie') || ''
  const cookie = cookies.split(';').find(c => c.trim().startsWith(name + '='))
  return cookie ? cookie.split('=')[1] : null
}

export function logout(): void {
  window.location.href =
    `https://remydre8.cloudflareaccess.com/cdn-cgi/access/logout` 
}

export function getLoginUrl(): string {
  const redirectUrl = encodeURIComponent(window.location.href)
  return `https://remydre8.cloudflareaccess.com/cdn-cgi/access/login?redirect_url=${redirectUrl}` 
}
