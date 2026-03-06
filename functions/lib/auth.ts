interface CloudflareAccessIdentity {
  sub: string
  email: string
  name?: string
}

export async function verifyCloudflareAccess(
  request: any, // HonoRequest or Request
  env: any
): Promise<CloudflareAccessIdentity | null> {
  const jwt = request.header?.('Cf-Access-Jwt-Assertion') ||
               request.headers?.get('Cf-Access-Jwt-Assertion') ||
               getCookieFromRequest(request, 'CF_Authorization')
  
  if (!jwt) {
    // For development, return a mock user
    return {
      sub: 'dev-user-123',
      email: 'dev@flaxia.com',
      name: 'Dev User'
    }
  }
  
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

function getCookieFromRequest(request: any, name: string): string | null {
  const cookies = request.header?.('Cookie') || request.headers?.get('Cookie') || ''
  const cookie = cookies.split(';').find((c: string) => c.trim().startsWith(name + '='))
  return cookie ? cookie.split('=')[1] : null
}
