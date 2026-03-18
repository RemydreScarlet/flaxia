/// <reference types="@cloudflare/workers-types" />
import { importPublicKey } from './crypto'

/**
 * Parse Signature header
 */
interface SignatureHeader {
  keyId: string
  headers: string[]
  signature: string
  algorithm?: string
}

function parseSignatureHeader(signatureHeader: string): SignatureHeader {
  console.log('Parsing signature header...')
  console.log('Full signature header:', signatureHeader)
  
  const parts = signatureHeader.split(',').map(part => part.trim())
  console.log('Signature parts count:', parts.length)
  
  const result: Partial<SignatureHeader> = {}

  for (const part of parts) {
    console.log('Processing part:', part)
    const match = part.match(/(\w+)="([^"]+)"/)
    if (match) {
      const [, key, value] = match
      console.log(`Found key: ${key}, value length: ${value.length}`)
      console.log(`Value (first 50 chars): ${value.substring(0, 50)}`)
      
      if (key === 'headers') {
        result[key] = value.split(' ')
      } else {
        result[key] = value
      }
    } else {
      console.log('Failed to match part:', part)
    }
  }

  console.log('Parsed result keys:', Object.keys(result))
  console.log('Has keyId:', !!result.keyId)
  console.log('Has headers:', !!result.headers)
  console.log('Has signature:', !!result.signature)

  if (!result.keyId || !result.headers || !result.signature) {
    console.error('Missing required fields in signature header')
    throw new Error('Invalid signature header format')
  }

  return result as SignatureHeader
}

/**
 * Verify HTTP Signature
 */
export async function verifyHttpSignature(request: Request, publicKeyPem: string): Promise<boolean> {
  try {
    const signatureHeader = request.headers.get('Signature')
    if (!signatureHeader) {
      console.error('Missing Signature header')
      return false
    }

    console.log('Signature header found, length:', signatureHeader.length)
    console.log('Signature header (first 100 chars):', signatureHeader.substring(0, 100))

    let parsed: SignatureHeader
    try {
      parsed = parseSignatureHeader(signatureHeader)
      console.log('Signature header parsed successfully')
      console.log('Key ID:', parsed.keyId)
      console.log('Headers:', parsed.headers)
      console.log('Signature length:', parsed.signature.length)
    } catch (error) {
      console.error('Failed to parse signature header:', error)
      return false
    }

    // Verify Date header is within ±30 minutes (replay attack protection)
    const dateHeader = request.headers.get('Date')
    if (!dateHeader) {
      console.error('Missing Date header')
      return false
    }

    const requestTime = new Date(dateHeader).getTime()
    const now = Date.now()
    const thirtyMinutes = 30 * 60 * 1000

    if (Math.abs(now - requestTime) > thirtyMinutes) {
      console.error('Request timestamp too old or too far in future')
      return false
    }

    // Build signing string
    const signingString = buildSigningString(request, parsed.headers)

    // Import public key
    const publicKey = await importPublicKey(publicKeyPem)

    // Decode signature (handle URL-safe base64)
    let signatureBase64 = parsed.signature
    
    console.log('Original signature length:', signatureBase64.length)
    console.log('Original signature (first 50 chars):', signatureBase64.substring(0, 50))
    console.log('Original signature (last 50 chars):', signatureBase64.substring(signatureBase64.length - 50))
    console.log('Original signature (last 10 chars):', signatureBase64.substring(signatureBase64.length - 10))
    
    // Check for invalid characters at the end
    const lastChar = signatureBase64.charAt(signatureBase64.length - 1)
    console.log('Last character:', lastChar, 'charCode:', lastChar.charCodeAt(0))
    
    // Remove any whitespace
    signatureBase64 = signatureBase64.replace(/\s/g, '')
    console.log('After whitespace removal length:', signatureBase64.length)
    
    // Convert URL-safe to standard base64
    signatureBase64 = signatureBase64
      .replace(/-/g, '+')
      .replace(/_/g, '/')
    
    console.log('Processed signature length:', signatureBase64.length)
    console.log('Processed signature (first 50 chars):', signatureBase64.substring(0, 50))
    console.log('Processed signature (last 10 chars):', signatureBase64.substring(signatureBase64.length - 10))
    
    // Pad with '=' to make length divisible by 4
    const originalLength = signatureBase64.length
    while (signatureBase64.length % 4 !== 0) {
      signatureBase64 += '='
    }
    
    console.log('Padded signature length:', signatureBase64.length)
    console.log('Added padding:', signatureBase64.length - originalLength)
    console.log('Final signature (last 10 chars):', signatureBase64.substring(signatureBase64.length - 10))
    
    // Validate base64 characters only
    const invalidChars = signatureBase64.replace(/[A-Za-z0-9+/=]/g, '')
    if (invalidChars) {
      console.error('Invalid base64 characters found:', invalidChars)
      console.error('Invalid chars count:', invalidChars.length)
      return false
    }
    
    console.log('Base64 validation passed, attempting decode...')
    
    try {
      // Use Buffer instead of atob() for Cloudflare Functions compatibility
      const signatureBuffer = Buffer.from(signatureBase64, 'base64')
      console.log('Base64 decode successful, signature length:', signatureBuffer.length)
      
      const signatureArray = new Uint8Array(signatureBuffer)
      console.log('Signature array created successfully')

      // Verify signature
      const encoder = new TextEncoder()
      const signingStringArray = encoder.encode(signingString)

      const isValid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        signatureArray,
        signingStringArray
      )

      console.log('Signature verification result:', isValid)
      return isValid
    } catch (error: any) {
      console.error('Base64 decode failed:', error?.message || error)
      console.error('Error type:', error?.constructor?.name)
      console.error('Stack trace:', error?.stack)
      console.error('Signature being decoded (first 100 chars):', signatureBase64.substring(0, 100))
      console.error('Full signature length:', signatureBase64.length)
      console.error('Last 10 chars:', signatureBase64.substring(signatureBase64.length - 10))
      return false
    }
  } catch (error: any) {
    console.error('Signature verification error:', error?.message || error)
    console.error('Error type:', error?.constructor?.name)
    console.error('Stack trace:', error?.stack)
    console.error('Error occurred in signature verification process')
    return false
  }
}

/**
 * Build signing string from headers
 */
function buildSigningString(request: Request, headers: string[]): string {
  const url = new URL(request.url)
  const lines: string[] = []

  for (const header of headers) {
    if (header === '(request-target)') {
      const method = request.method.toLowerCase()
      const path = url.pathname + url.search
      lines.push(`(request-target): ${method} ${path}`)
    } else {
      const value = request.headers.get(header)
      if (value === null) {
        throw new Error(`Missing required header: ${header}`)
      }
      lines.push(`${header}: ${value}`)
    }
  }

  return lines.join('\n')
}

/**
 * Verify Digest header
 */
export async function verifyDigest(request: Request, body: string): Promise<boolean> {
  try {
    const digestHeader = request.headers.get('Digest')
    if (!digestHeader) {
      console.error('Missing Digest header')
      return false
    }

    // Parse Digest header (e.g., "SHA-256=xyz123...")
    const match = digestHeader.match(/SHA-256=([A-Za-z0-9+/=]+)/)
    if (!match) {
      console.error('Invalid Digest header format')
      return false
    }

    const expectedDigest = match[1]

    // Calculate actual digest
    const encoder = new TextEncoder()
    const data = encoder.encode(body)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = new Uint8Array(hashBuffer)
    const actualDigest = btoa(String.fromCharCode(...hashArray))

    return expectedDigest === actualDigest
  } catch (error) {
    console.error('Digest verification error:', error)
    return false
  }
}

/**
 * Fetch actor's public key from their URL
 */
export async function fetchActorPublicKey(actorUrl: string): Promise<string | null> {
  try {
    const response = await fetch(actorUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json'
      }
    })

    if (!response.ok) {
      console.error(`Failed to fetch actor: ${response.status}`)
      return null
    }

    const actor = await response.json()
    
    if (!actor.publicKey || !actor.publicKey.publicKeyPem) {
      console.error('Actor missing publicKey.publicKeyPem')
      return null
    }

    return actor.publicKey.publicKeyPem
  } catch (error) {
    console.error('Error fetching actor public key:', error)
    return null
  }
}

/**
 * Import private key from PEM format
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemHeader = '-----BEGIN PRIVATE KEY-----'
  const pemFooter = '-----END PRIVATE KEY-----'
  const pemContents = pem.substring(pemHeader.length, pem.length - pemFooter.length)
    .replace(/\n/g, '')

  const binaryDer = atob(pemContents)
  const binaryDerArray = new Uint8Array(binaryDer.length)
  for (let i = 0; i < binaryDer.length; i++) {
    binaryDerArray[i] = binaryDer.charCodeAt(i)
  }

  return crypto.subtle.importKey(
    'pkcs8',
    binaryDerArray.buffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    true,
    ['sign']
  )
}

/**
 * Sign an outgoing ActivityPub request with HTTP Signature
 */
export async function signRequest(
  url: string,
  body: string,
  privateKeyPem: string,
  keyId: string
): Promise<Headers> {
  const headers = new Headers()

  // Calculate digest
  const encoder = new TextEncoder()
  const bodyArray = encoder.encode(body)
  const hashBuffer = await crypto.subtle.digest('SHA-256', bodyArray)
  const hashArray = new Uint8Array(hashBuffer)
  const digest = btoa(String.fromCharCode(...hashArray))

  // Set Date header
  const date = new Date().toUTCString()
  headers.set('Date', date)

  // Set Digest header
  headers.set('Digest', `sha-256=${digest}`)

  // Set Content-Type
  headers.set('Content-Type', 'application/activity+json')

  // Build signing string
  const parsedUrl = new URL(url)
  const path = parsedUrl.pathname + parsedUrl.search
  const signingString = [
    `(request-target): post ${path}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
    `digest: sha-256=${digest}`
  ].join('\n')

  console.log('Signing string:')
  console.log(signingString)

  // Import private key
  const privateKey = await importPrivateKey(privateKeyPem)

  // Sign
  const signingArray = encoder.encode(signingString)
  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    signingArray
  )

  // Convert signature to base64 (not base64url)
  const signatureArray = new Uint8Array(signatureBuffer)
  const signature = btoa(String.fromCharCode(...signatureArray))

  // Set Signature header
  headers.set('Signature', `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`)

  return headers
}
