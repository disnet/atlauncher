// Mock PDS authorization server that is also a FedCM identity provider
// (Phase 2). This is the "clean" design: the FedCM assertion is an OAuth
// authorization code bound to
//   - the requesting app's client_id (its origin, checked against Origin),
//   - a PKCE challenge, and
//   - the app's DPoP key thumbprint (dpop_jkt),
// all passed through FedCM `params`. The app redeems it at /oauth/token with
// its own DPoP key. No popup, no redirect, and the shell is not involved.
//
// Deliberately simplified versus a real atproto PDS: no DPoP server nonces,
// no PAR, no client metadata fetch, in-memory state, three fixed accounts.

import { randomBytes, createHash } from 'node:crypto'
import { calculateJwkThumbprint, EmbeddedJWK, jwtVerify, decodeProtectedHeader } from 'jose'
import { APP_ORIGIN, PDS_ORIGIN, PDS_PORT } from '../lib/config.ts'
import {
  fedcmCors,
  getCookie,
  html,
  isWebIdentityRequest,
  json,
  readParams,
  startServer,
  type Handler,
} from '../lib/http.ts'
import type { Did, PdsAssertion } from '../protocol/messages.ts'

export const MOCK_ACCOUNTS: { did: Did; handle: string; displayName: string; description: string }[] = [
  { did: 'did:plc:mockalice0000000000000000', handle: 'alice.mock', displayName: 'Alice (mock)', description: 'Lives on the mock PDS.' },
  { did: 'did:plc:mockbob000000000000000000', handle: 'bob.mock', displayName: 'Bob (mock)', description: 'Also lives on the mock PDS.' },
  { did: 'did:plc:mockcarol0000000000000000', handle: 'carol.mock', displayName: 'Carol (mock)', description: 'Signed in only when you tick her box.' },
]

const APPROVED_CLIENTS = new Set([APP_ORIGIN])
const COOKIE = 'pds_signed_in'
const TOKEN_ENDPOINT = `${PDS_ORIGIN}/oauth/token`

const b64url = (b: Buffer) => b.toString('base64url')
const sha256 = (s: string) => b64url(createHash('sha256').update(s).digest())
const rand = () => b64url(randomBytes(24))

interface CodeGrant {
  client_id: string
  sub: Did
  scope: string
  code_challenge: string
  dpop_jkt: string
  expires: number
}
interface TokenGrant {
  client_id: string
  sub: Did
  scope: string
  jkt: string
  expires: number
}
const codes = new Map<string, CodeGrant>()
const accessTokens = new Map<string, TokenGrant>()
const refreshTokens = new Map<string, TokenGrant>()
const seenJti = new Map<string, number>()

function signedIn(req: Parameters<Handler>[0]): Did[] {
  const v = getCookie(req, COOKIE)
  if (!v) return []
  return v.split(',').filter((d): d is Did => MOCK_ACCOUNTS.some((a) => a.did === d))
}

const loginCookie = (dids: Did[]) =>
  `${COOKIE}=${encodeURIComponent(dids.join(','))}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${dids.length ? 2592000 : 0}`

// ---- DPoP verification -----------------------------------------------------

async function verifyDpop(proof: string | undefined, htm: string, htu: string, accessToken?: string) {
  if (!proof) throw new OAuthError('invalid_dpop_proof', 'missing DPoP header')
  const { payload } = await jwtVerify(proof, EmbeddedJWK, { typ: 'dpop+jwt', algorithms: ['ES256'] })
  const { jwk } = decodeProtectedHeader(proof)
  if (!jwk) throw new OAuthError('invalid_dpop_proof', 'no jwk')
  if (payload.htm !== htm) throw new OAuthError('invalid_dpop_proof', 'htm mismatch')
  if (payload.htu !== htu) throw new OAuthError('invalid_dpop_proof', 'htu mismatch')
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.iat !== 'number' || Math.abs(now - payload.iat) > 60) throw new OAuthError('invalid_dpop_proof', 'stale iat')
  if (typeof payload.jti !== 'string' || seenJti.has(payload.jti)) throw new OAuthError('invalid_dpop_proof', 'jti replay')
  seenJti.set(payload.jti, now)
  for (const [k, t] of seenJti) if (now - t > 120) seenJti.delete(k)
  if (accessToken !== undefined && payload.ath !== sha256(accessToken)) throw new OAuthError('invalid_dpop_proof', 'ath mismatch')
  return calculateJwkThumbprint(jwk, 'sha256')
}

class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
  }
}

// ---- handlers ----------------------------------------------------------------

const cors = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-headers': 'authorization, dpop, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': 'dpop-nonce, www-authenticate',
  vary: 'Origin',
}

export const fedcm: Handler = async (req, res, url) => {
  const p = url.pathname
  if (p === '/.well-known/web-identity') {
    // One config URL only; with client_metadata, Chrome also wants these two.
    json(res, 200, {
      provider_urls: [`${PDS_ORIGIN}/fedcm/config.json`],
      accounts_endpoint: `${PDS_ORIGIN}/fedcm/accounts`,
      login_url: `${PDS_ORIGIN}/login?fedcm-login=1`,
    })
    return true
  }
  if (p === '/fedcm/config.json') {
    json(res, 200, {
      accounts_endpoint: `${PDS_ORIGIN}/fedcm/accounts`,
      client_metadata_endpoint: `${PDS_ORIGIN}/fedcm/client_metadata`,
      id_assertion_endpoint: `${PDS_ORIGIN}/fedcm/assertion`,
      login_url: `${PDS_ORIGIN}/login?fedcm-login=1`,
      branding: { background_color: '#3b1f6e', color: '#ffffff', name: 'mock PDS' },
    })
    return true
  }
  if (p === '/fedcm/client_metadata') {
    json(res, 200, { privacy_policy_url: `${PDS_ORIGIN}/#privacy`, terms_of_service_url: `${PDS_ORIGIN}/#terms` })
    return true
  }
  if (p === '/fedcm/accounts') {
    if (!isWebIdentityRequest(req)) return json(res, 400, { error: 'not a FedCM request' }), true
    const dids = signedIn(req)
    if (!dids.length) return json(res, 401, { error: 'not signed in' }, { 'set-login': 'logged-out' }), true
    json(res, 200, {
      accounts: MOCK_ACCOUNTS.filter((a) => dids.includes(a.did)).map((a) => ({
        id: a.did,
        name: a.displayName,
        email: a.handle,
        given_name: a.displayName,
        login_hints: [a.did, a.handle],
        approved_clients: [...APPROVED_CLIENTS],
      })),
    })
    return true
  }
  if (p === '/fedcm/assertion' && req.method === 'POST') {
    const origin = req.headers.origin ?? ''
    const fail = (code: string, status = 400) =>
      json(res, status, { error: { code, url: `${PDS_ORIGIN}/#error-${code}` } }, fedcmCors(origin))
    if (!isWebIdentityRequest(req)) return fail('not_fedcm'), true
    if (!APPROVED_CLIENTS.has(origin)) return fail('unknown_client', 403), true
    const body = await readParams(req)
    if (body.client_id !== origin) return fail('client_id_mismatch', 403), true
    const sub = body.account_id as Did
    if (!signedIn(req).includes(sub)) return fail('unknown_account', 401), true

    let params: Record<string, unknown> = {}
    try {
      params = body.params ? JSON.parse(body.params) : {}
    } catch {
      return fail('bad_params'), true
    }
    if (params.code_challenge_method !== 'S256' || typeof params.code_challenge !== 'string') return fail('pkce_required'), true
    if (typeof params.dpop_jkt !== 'string') return fail('dpop_jkt_required'), true
    const scope = typeof params.scope === 'string' ? params.scope : 'atproto'
    if (!scope.split(' ').includes('atproto')) return fail('invalid_scope'), true

    const code = rand()
    codes.set(code, {
      client_id: origin,
      sub,
      scope,
      code_challenge: params.code_challenge,
      dpop_jkt: params.dpop_jkt,
      expires: Date.now() + 60_000,
    })
    const token: PdsAssertion = { kind: 'atproto.oauth-code', code, iss: PDS_ORIGIN, token_endpoint: TOKEN_ENDPOINT, sub }
    json(res, 200, { token: JSON.stringify(token) }, fedcmCors(origin))
    return true
  }
  return false
}

export const oauth: Handler = async (req, res, url) => {
  if (url.pathname !== '/oauth/token') return false
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end(), true
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, cors), true
  try {
    const body = await readParams(req)
    const jkt = await verifyDpop(req.headers.dpop as string | undefined, 'POST', TOKEN_ENDPOINT)
    let grant: TokenGrant
    if (body.grant_type === 'authorization_code') {
      const c = codes.get(body.code)
      codes.delete(body.code) // single use
      if (!c || c.expires < Date.now()) throw new OAuthError('invalid_grant', 'unknown or expired code')
      if (c.client_id !== body.client_id) throw new OAuthError('invalid_grant', 'client_id mismatch')
      if (sha256(body.code_verifier ?? '') !== c.code_challenge) throw new OAuthError('invalid_grant', 'PKCE mismatch')
      if (jkt !== c.dpop_jkt) throw new OAuthError('invalid_dpop_proof', 'key does not match dpop_jkt')
      grant = { client_id: c.client_id, sub: c.sub, scope: c.scope, jkt, expires: 0 }
    } else if (body.grant_type === 'refresh_token') {
      const r = refreshTokens.get(body.refresh_token)
      refreshTokens.delete(body.refresh_token) // rotate
      if (!r || r.client_id !== body.client_id) throw new OAuthError('invalid_grant', 'unknown refresh token')
      if (r.jkt !== jkt) throw new OAuthError('invalid_dpop_proof', 'refresh token bound to another key')
      grant = { ...r }
    } else {
      throw new OAuthError('unsupported_grant_type', String(body.grant_type))
    }
    const access = rand()
    const refresh = rand()
    const expiresIn = 300
    accessTokens.set(access, { ...grant, expires: Date.now() + expiresIn * 1000 })
    refreshTokens.set(refresh, { ...grant, expires: Date.now() + 7 * 86400_000 })
    json(res, 200, {
      access_token: access,
      token_type: 'DPoP',
      expires_in: expiresIn,
      refresh_token: refresh,
      scope: grant.scope,
      sub: grant.sub,
    }, cors)
  } catch (err) {
    const e = err instanceof OAuthError ? err : new OAuthError('invalid_dpop_proof', String(err))
    json(res, e.status, { error: e.code, error_description: e.message }, cors)
  }
  return true
}

export const xrpc: Handler = async (req, res, url) => {
  if (url.pathname !== '/xrpc/app.bsky.actor.getProfile') return false
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end(), true
  const auth = req.headers.authorization ?? ''
  const token = auth.startsWith('DPoP ') ? auth.slice(5) : ''
  const grant = accessTokens.get(token)
  if (!grant || grant.expires < Date.now()) return json(res, 401, { error: 'InvalidToken' }, cors), true
  try {
    const jkt = await verifyDpop(req.headers.dpop as string | undefined, 'GET', `${PDS_ORIGIN}${url.pathname}`, token)
    if (jkt !== grant.jkt) throw new Error('key mismatch')
  } catch (err) {
    return json(res, 401, { error: 'InvalidDPoP', message: String(err) }, cors), true
  }
  const actor = url.searchParams.get('actor')
  const a = MOCK_ACCOUNTS.find((x) => x.did === actor || x.handle === actor)
  if (!a) return json(res, 400, { error: 'NotFound' }, cors), true
  json(res, 200, {
    did: a.did,
    handle: a.handle,
    displayName: a.displayName,
    description: `${a.description}\nSigned in through FedCM with a DPoP-bound code, no popup.`,
    followersCount: 3,
    followsCount: 2,
    postsCount: 0,
  }, cors)
  return true
}

/** Login page. Like a real auth server, it refuses to be framed. */
export const login: Handler = async (req, res, url) => {
  if (url.pathname !== '/login' && url.pathname !== '/') return false
  const noFrame = { 'content-security-policy': `frame-ancestors 'none'` }
  let dids = signedIn(req)
  const headers: Record<string, string> = { ...noFrame }
  let justSaved = false
  if (req.method === 'POST') {
    const body = new URLSearchParams(Object.entries(await readParams(req)))
    dids = MOCK_ACCOUNTS.filter((a) => body.has(a.did)).map((a) => a.did)
    headers['set-cookie'] = loginCookie(dids)
    headers['set-login'] = dids.length ? 'logged-in' : 'logged-out'
    justSaved = true
  }
  const fedcmLogin = url.searchParams.has('fedcm-login')
  html(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>mock PDS</title><style>body{font:14px system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}label{display:block;margin:8px 0}button{padding:7px 12px}</style></head>
<body><h1>mock PDS</h1>
<p>Pretend to sign in. Ticked accounts are what FedCM will offer to apps.</p>
<form method="post">
${MOCK_ACCOUNTS.map((a) => `<label><input type="checkbox" name="${a.did}" ${dids.includes(a.did) ? 'checked' : ''}> ${a.displayName} <small>@${a.handle}</small></label>`).join('\n')}
<button>Save</button></form>
${justSaved ? '<p>Saved.</p>' : ''}
<script>
${justSaved && fedcmLogin && dids.length ? 'if (window.IdentityProvider) IdentityProvider.close()' : ''}
${justSaved ? `navigator.login && navigator.login.setStatus(${JSON.stringify(dids.length ? 'logged-in' : 'logged-out')})` : ''}
</script></body></html>`, headers)
  return true
}

export const start = () => startServer('mock-pds', PDS_PORT, [fedcm, oauth, xrpc, login])
