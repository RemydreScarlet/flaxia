/// <reference types="@cloudflare/workers-types" />

/**
 * Generate RSA-SHA256 key pair for ActivityPub
 */
export async function generateKeyPair(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: 'SHA-256',
    },
    true, // extractable
    ['sign', 'verify']
  )

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
  }
}

/**
 * Export public key to PEM format
 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', key)
  const exportedAsString = String.fromCharCode(...new Uint8Array(exported))
  const exportedAsBase64 = btoa(exportedAsString)
  const pemHeader = '-----BEGIN PUBLIC KEY-----\n'
  const pemFooter = '\n-----END PUBLIC KEY-----'
  
  // Add line breaks every 64 characters for proper PEM format
  const base64WithLines = exportedAsBase64.match(/.{1,64}/g)?.join('\n') || exportedAsBase64
  
  return pemHeader + base64WithLines + pemFooter
}

/**
 * Export private key to PEM format
 */
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('pkcs8', key)
  const exportedAsString = String.fromCharCode(...new Uint8Array(exported))
  const exportedAsBase64 = btoa(exportedAsString)
  const pemHeader = '-----BEGIN PRIVATE KEY-----\n'
  const pemFooter = '\n-----END PRIVATE KEY-----'
  
  // Add line breaks every 64 characters for proper PEM format
  const base64WithLines = exportedAsBase64.match(/.{1,64}/g)?.join('\n') || exportedAsBase64
  
  return pemHeader + base64WithLines + pemFooter
}

/**
 * Import public key from PEM format
 */
export async function importPublicKey(pem: string): Promise<CryptoKey> {
  // Remove PEM header and footer
  const pemHeader = '-----BEGIN PUBLIC KEY-----'
  const pemFooter = '-----END PUBLIC KEY-----'
  const pemContents = pem.substring(pemHeader.length, pem.length - pemFooter.length)
    .replace(/\n/g, '')
  
  // Decode base64
  const binaryDer = atob(pemContents)
  const binaryDerArray = new Uint8Array(binaryDer.length)
  for (let i = 0; i < binaryDer.length; i++) {
    binaryDerArray[i] = binaryDer.charCodeAt(i)
  }
  
  return crypto.subtle.importKey(
    'spki',
    binaryDerArray.buffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    true,
    ['verify']
  )
}

/**
 * Import private key from PEM format
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Remove PEM header and footer
  const pemHeader = '-----BEGIN PRIVATE KEY-----'
  const pemFooter = '-----END PRIVATE KEY-----'
  const pemContents = pem.substring(pemHeader.length, pem.length - pemFooter.length)
    .replace(/\n/g, '')
  
  // Decode base64
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
