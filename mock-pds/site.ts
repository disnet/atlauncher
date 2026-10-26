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
// no PAR, no client metadata fetch, three fixed accounts. State lives in
// memory locally and in D1 when deployed (see lib/store.ts).

import { base64url, calculateJwkThumbprint, EmbeddedJWK, jwtVerify, decodeProtectedHeader } from 'jose'
import { APP_ORIGIN, PDS_ORIGIN } from '../lib/config.ts'
import { empty, fedcmCors, getCookie, html, isWebIdentityRequest, json, readParams, type Handler, type Site } from '../lib/http.ts'
import type { Tables } from '../lib/store.ts'
import type { Did, PdsAssertion } from '../protocol/messages.ts'

export const MOCK_ACCOUNTS: { did: Did; handle: string; displayName: string; description: string }[] = [
  { did: 'did:plc:mockalice0000000000000000', handle: 'alice.mock', displayName: 'Alice (mock)', description: 'Lives on the mock PDS.' },
  { did: 'did:plc:mockbob000000000000000000', handle: 'bob.mock', displayName: 'Bob (mock)', description: 'Also lives on the mock PDS.' },
  { did: 'did:plc:mockcarol0000000000000000', handle: 'carol.mock', displayName: 'Carol (mock)', description: 'Signed in only when you tick her box.' },
]

const APPROVED_CLIENTS = new Set([APP_ORIGIN])
const COOKIE = 'pds_signed_in'
const TOKEN_ENDPOINT = `${PDS_ORIGIN}/oauth/token`

const sha256 = async (s: string) => base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
const rand = () => base64url.encode(crypto.getRandomValues(new Uint8Array(24)))

interface CodeGrant {
  client_id: string
  sub: Did
  scope: string
  code_challenge: string
  dpop_jkt: string
}
interface TokenGrant {
  client_id: string
  sub: Did
  scope: string
  jkt: string
}
const CODE_TTL_MS = 60_000
const ACCESS_TTL_S = 300
const REFRESH_TTL_MS = 7 * 86400_000
const JTI_TTL_MS = 120_000

function signedIn(req: Request): Did[] {
  const v = getCookie(req, COOKIE)
  if (!v) return []
  return v.split(',').filter((d): d is Did => MOCK_ACCOUNTS.some((a) => a.did === d))
}

const loginCookie = (dids: Did[]) =>
  `${COOKIE}=${encodeURIComponent(dids.join(','))}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${dids.length ? 2592000 : 0}`

class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
  }
}

const cors = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-headers': 'authorization, dpop, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': 'dpop-nonce, www-authenticate',
  vary: 'Origin',
}

const fedcmEndpoints: Handler = (req, url) => {
  const p = url.pathname
  if (p === '/.well-known/web-identity') {
    // One config URL only; with client_metadata, Chrome also wants these two.
    return json(200, {
      provider_urls: [`${PDS_ORIGIN}/fedcm/config.json`],
      accounts_endpoint: `${PDS_ORIGIN}/fedcm/accounts`,
      login_url: `${PDS_ORIGIN}/login?fedcm-login=1`,
    })
  }
  if (p === '/fedcm/config.json') {
    return json(200, {
      accounts_endpoint: `${PDS_ORIGIN}/fedcm/accounts`,
      client_metadata_endpoint: `${PDS_ORIGIN}/fedcm/client_metadata`,
      id_assertion_endpoint: `${PDS_ORIGIN}/fedcm/assertion`,
      login_url: `${PDS_ORIGIN}/login?fedcm-login=1`,
      branding: { background_color: '#3b1f6e', color: '#ffffff', name: 'mock PDS' },
    })
  }
  if (p === '/fedcm/client_metadata') {
    return json(200, { privacy_policy_url: `${PDS_ORIGIN}/#privacy`, terms_of_service_url: `${PDS_ORIGIN}/#terms` })
  }
  if (p === '/fedcm/accounts') {
    if (!isWebIdentityRequest(req)) return json(400, { error: 'not a FedCM request' })
    const dids = signedIn(req)
    if (!dids.length) return json(401, { error: 'not signed in' }, { 'set-login': 'logged-out' })
    return json(200, {
      accounts: MOCK_ACCOUNTS.filter((a) => dids.includes(a.did)).map((a) => ({
        id: a.did,
        name: a.displayName,
        email: a.handle,
        given_name: a.displayName,
        login_hints: [a.did, a.handle],
        approved_clients: [...APPROVED_CLIENTS],
      })),
    })
  }
}

export function pdsSite(tables: Tables): Site {
  const codes = tables<CodeGrant>('pds_codes')
  const accessTokens = tables<TokenGrant>('pds_access')
  const refreshTokens = tables<TokenGrant>('pds_refresh')
  const seenJti = tables<true>('pds_jti')

  // ---- DPoP verification ---------------------------------------------------

  async function verifyDpop(proof: string | null, htm: string, htu: string, accessToken?: string) {
    if (!proof) throw new OAuthError('invalid_dpop_proof', 'missing DPoP header')
    const { payload } = await jwtVerify(proof, EmbeddedJWK, { typ: 'dpop+jwt', algorithms: ['ES256'] })
    const { jwk } = decodeProtectedHeader(proof)
    if (!jwk) throw new OAuthError('invalid_dpop_proof', 'no jwk')
    if (payload.htm !== htm) throw new OAuthError('invalid_dpop_proof', 'htm mismatch')
    if (payload.htu !== htu) throw new OAuthError('invalid_dpop_proof', 'htu mismatch')
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.iat !== 'number' || Math.abs(now - payload.iat) > 60) throw new OAuthError('invalid_dpop_proof', 'stale iat')
    if (typeof payload.jti !== 'string' || !(await seenJti.add(payload.jti, true, JTI_TTL_MS))) {
      throw new OAuthError('invalid_dpop_proof', 'jti replay')
    }
    if (accessToken !== undefined && payload.ath !== (await sha256(accessToken))) throw new OAuthError('invalid_dpop_proof', 'ath mismatch')
    return calculateJwkThumbprint(jwk, 'sha256')
  }

  // ---- handlers --------------------------------------------------------------

  const assertion: Handler = async (req, url) => {
    if (url.pathname !== '/fedcm/assertion' || req.method !== 'POST') return
    const origin = req.headers.get('origin') ?? ''
    const fail = (code: string, status = 400) =>
      json(status, { error: { code, url: `${PDS_ORIGIN}/#error-${code}` } }, fedcmCors(origin))
    if (!isWebIdentityRequest(req)) return fail('not_fedcm')
    if (!APPROVED_CLIENTS.has(origin)) return fail('unknown_client', 403)
    const body = await readParams(req)
    if (body.client_id !== origin) return fail('client_id_mismatch', 403)
    const sub = body.account_id as Did
    if (!signedIn(req).includes(sub)) return fail('unknown_account', 401)

    let params: Record<string, unknown> = {}
    try {
      params = body.params ? JSON.parse(body.params) : {}
    } catch {
      return fail('bad_params')
    }
    if (params.code_challenge_method !== 'S256' || typeof params.code_challenge !== 'string') return fail('pkce_required')
    if (typeof params.dpop_jkt !== 'string') return fail('dpop_jkt_required')
    const scope = typeof params.scope === 'string' ? params.scope : 'atproto'
    if (!scope.split(' ').includes('atproto')) return fail('invalid_scope')

    const code = rand()
    await codes.set(
      code,
      { client_id: origin, sub, scope, code_challenge: params.code_challenge, dpop_jkt: params.dpop_jkt },
      CODE_TTL_MS,
    )
    const token: PdsAssertion = { kind: 'atproto.oauth-code', code, iss: PDS_ORIGIN, token_endpoint: TOKEN_ENDPOINT, sub }
    return json(200, { token: JSON.stringify(token) }, fedcmCors(origin))
  }

  const oauth: Handler = async (req, url) => {
    if (url.pathname !== '/oauth/token') return
    if (req.method === 'OPTIONS') return empty(204, cors)
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, cors)
    try {
      const body = await readParams(req)
      const jkt = await verifyDpop(req.headers.get('dpop'), 'POST', TOKEN_ENDPOINT)
      let grant: TokenGrant
      if (body.grant_type === 'authorization_code') {
        const c = await codes.take(body.code) // single use
        if (!c) throw new OAuthError('invalid_grant', 'unknown or expired code')
        if (c.client_id !== body.client_id) throw new OAuthError('invalid_grant', 'client_id mismatch')
        if ((await sha256(body.code_verifier ?? '')) !== c.code_challenge) throw new OAuthError('invalid_grant', 'PKCE mismatch')
        if (jkt !== c.dpop_jkt) throw new OAuthError('invalid_dpop_proof', 'key does not match dpop_jkt')
        grant = { client_id: c.client_id, sub: c.sub, scope: c.scope, jkt }
      } else if (body.grant_type === 'refresh_token') {
        const r = await refreshTokens.take(body.refresh_token) // rotate
        if (!r || r.client_id !== body.client_id) throw new OAuthError('invalid_grant', 'unknown refresh token')
        if (r.jkt !== jkt) throw new OAuthError('invalid_dpop_proof', 'refresh token bound to another key')
        grant = r
      } else {
        throw new OAuthError('unsupported_grant_type', String(body.grant_type))
      }
      const access = rand()
      const refresh = rand()
      await accessTokens.set(access, grant, ACCESS_TTL_S * 1000)
      await refreshTokens.set(refresh, grant, REFRESH_TTL_MS)
      return json(200, {
        access_token: access,
        token_type: 'DPoP',
        expires_in: ACCESS_TTL_S,
        refresh_token: refresh,
        scope: grant.scope,
        sub: grant.sub,
      }, cors)
    } catch (err) {
      const e = err instanceof OAuthError ? err : new OAuthError('invalid_dpop_proof', String(err))
      return json(e.status, { error: e.code, error_description: e.message }, cors)
    }
  }

  const xrpc: Handler = async (req, url) => {
    if (url.pathname !== '/xrpc/app.bsky.actor.getProfile') return
    if (req.method === 'OPTIONS') return empty(204, cors)
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('DPoP ') ? auth.slice(5) : ''
    const grant = token ? await accessTokens.get(token) : undefined
    if (!grant) return json(401, { error: 'InvalidToken' }, cors)
    try {
      const jkt = await verifyDpop(req.headers.get('dpop'), 'GET', `${PDS_ORIGIN}${url.pathname}`, token)
      if (jkt !== grant.jkt) throw new Error('key mismatch')
    } catch (err) {
      return json(401, { error: 'InvalidDPoP', message: String(err) }, cors)
    }
    const actor = url.searchParams.get('actor')
    const a = MOCK_ACCOUNTS.find((x) => x.did === actor || x.handle === actor)
    if (!a) return json(400, { error: 'NotFound' }, cors)
    return json(200, {
      did: a.did,
      handle: a.handle,
      displayName: a.displayName,
      description: `${a.description}\nSigned in through FedCM with a DPoP-bound code, no popup.`,
      followersCount: 3,
      followsCount: 2,
      postsCount: 0,
    }, cors)
  }

  return { name: 'mock-pds', handlers: [fedcmEndpoints, assertion, oauth, xrpc, login] }
}

/** Login page. Like a real auth server, it refuses to be framed. */
const login: Handler = async (req, url) => {
  if (url.pathname !== '/login' && url.pathname !== '/') return
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
  return html(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
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
}
