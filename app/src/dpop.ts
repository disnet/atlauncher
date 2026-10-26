// A small DPoP (RFC 9449) client for the Phase 2 mock PDS, using WebCrypto.
// Phase 1 doesn't need this: @atproto/oauth-client-browser does DPoP itself.

export interface DpopKey {
  privateKey: CryptoKey // non-extractable
  publicJwk: JsonWebKey
  jkt: string // JWK thumbprint (RFC 7638), base64url
}

const enc = new TextEncoder()

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256b64url(input: string) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(input)))
}

export async function jwkThumbprint(jwk: JsonWebKey) {
  // Required members only, lexicographic order, no whitespace.
  return sha256b64url(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
}

export async function generateDpopKey(): Promise<DpopKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const full = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const publicJwk = { kty: full.kty, crv: full.crv, x: full.x, y: full.y }
  return { privateKey: pair.privateKey, publicJwk, jkt: await jwkThumbprint(publicJwk) }
}

/** Builds a DPoP proof JWT for one request. */
export async function dpopProof(
  key: DpopKey,
  htm: string,
  htu: string,
  accessToken?: string,
): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk }
  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm,
    htu: htu.split(/[?#]/)[0],
    iat: Math.floor(Date.now() / 1000),
  }
  if (accessToken) payload.ath = await sha256b64url(accessToken)
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`
  // WebCrypto ECDSA signatures are already in JWS (r||s) form.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, enc.encode(input))
  return `${input}.${b64url(sig)}`
}

export async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: await sha256b64url(verifier) }
}
