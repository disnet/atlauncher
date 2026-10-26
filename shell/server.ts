// atworkplace shell server (Phase 1).
//
// Two jobs:
//  1. Serve the shell page that frames atproto apps.
//  2. Act as a FedCM identity provider whose "accounts" are the atproto
//     accounts the user has added to the shell. Its assertion is only a hint
//     ("the user picked did:plc:..."), never a credential: the framed app
//     still signs in with real atproto OAuth against that account's PDS.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ORIGIN, PDS_ORIGIN, SHELL_ORIGIN, SHELL_PORT } from '../lib/config.ts'
import {
  fedcmCors,
  getCookie,
  isWebIdentityRequest,
  json,
  readBody,
  readParams,
  serveStatic,
  sessionCookie,
  startServer,
  type Handler,
} from '../lib/http.ts'
import { isDid, type ShellAssertion } from '../protocol/messages.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const DATA_FILE = join(root, '.data', 'shell.json')
const COOKIE = 'awp_sid'

/** Apps allowed to ask this IdP which account to use. client_id === origin. */
export const APPROVED_APPS: Record<string, { name: string }> = {
  [APP_ORIGIN]: { name: 'atworkplace demo app' },
}

export interface ShellAccount {
  did: `did:${string}`
  handle: string
  displayName?: string
  avatar?: string
}

// ---- tiny persistent store: session id -> accounts -----------------------

type Store = Record<string, ShellAccount[]>
let store: Store = {}
try {
  store = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
} catch {}
const save = () => {
  mkdirSync(dirname(DATA_FILE), { recursive: true })
  writeFileSync(DATA_FILE, JSON.stringify(store, null, 2))
}

function sessionFor(req: Parameters<Handler>[0]) {
  const sid = getCookie(req, COOKIE)
  return sid && store[sid] ? sid : undefined
}

/** FedCM Login Status API: tell the browser whether we have accounts. */
const loginStatus = (accounts: ShellAccount[]) =>
  ({ 'set-login': accounts.length ? 'logged-in' : 'logged-out' }) as Record<string, string>

// ---- FedCM endpoints -----------------------------------------------------

const configUrl = `${SHELL_ORIGIN}/fedcm/config.json`

export const fedcm: Handler = async (req, res, url) => {
  const p = url.pathname

  if (p === '/.well-known/web-identity') {
    // Chrome allows exactly one config URL here; listing the mock PDS's too
    // fails every FedCM call with "contains too many config URLs". Because
    // the IdP uses client_metadata, Chrome also wants accounts_endpoint and
    // login_url repeated here.
    json(res, 200, {
      provider_urls: [configUrl],
      accounts_endpoint: `${SHELL_ORIGIN}/fedcm/accounts`,
      login_url: `${SHELL_ORIGIN}/?fedcm-login=1`,
    })
    return true
  }

  if (p === '/fedcm/config.json') {
    json(res, 200, {
      accounts_endpoint: `${SHELL_ORIGIN}/fedcm/accounts`,
      client_metadata_endpoint: `${SHELL_ORIGIN}/fedcm/client_metadata`,
      id_assertion_endpoint: `${SHELL_ORIGIN}/fedcm/assertion`,
      login_url: `${SHELL_ORIGIN}/?fedcm-login=1`,
      branding: {
        background_color: '#1d2433',
        color: '#ffffff',
        name: 'atworkplace',
      },
    })
    return true
  }

  if (p === '/fedcm/client_metadata') {
    json(res, 200, {
      privacy_policy_url: `${SHELL_ORIGIN}/#privacy`,
      terms_of_service_url: `${SHELL_ORIGIN}/#terms`,
    })
    return true
  }

  if (p === '/fedcm/accounts') {
    if (!isWebIdentityRequest(req)) return json(res, 400, { error: 'not a FedCM request' }), true
    const sid = sessionFor(req)
    const accounts = sid ? store[sid] : []
    if (!accounts.length) return json(res, 401, { error: 'no accounts' }, loginStatus([])), true
    json(res, 200, {
      accounts: accounts.map((a) => ({
        id: a.did,
        name: a.displayName || a.handle,
        // FedCM's account chooser shows this line; atproto has no email,
        // so the handle stands in for it.
        email: a.handle,
        given_name: a.displayName || a.handle,
        picture: a.avatar,
        // Lets an app call FedCM with loginHint: did or handle.
        login_hints: [a.did, a.handle],
        approved_clients: Object.keys(APPROVED_APPS),
      })),
    })
    return true
  }

  if (p === '/fedcm/assertion' && req.method === 'POST') {
    const origin = req.headers.origin ?? ''
    if (!isWebIdentityRequest(req)) return json(res, 400, { error: 'not a FedCM request' }), true
    const params = await readParams(req)
    const fail = (code: string, status = 400) =>
      json(res, status, { error: { code, url: `${SHELL_ORIGIN}/#error-${code}` } }, fedcmCors(origin))

    // client_id is the app's origin; the browser-supplied Origin must match.
    if (!APPROVED_APPS[origin]) return fail('unknown_client', 403), true
    if (params.client_id !== origin) return fail('client_id_mismatch', 403), true

    const sid = sessionFor(req)
    const account = sid && store[sid].find((a) => a.did === params.account_id)
    if (!account) return fail('unknown_account', 401), true

    let rpParams: Record<string, unknown> = {}
    try {
      rpParams = params.params ? JSON.parse(params.params) : {}
    } catch {}
    const nonce = String(rpParams.nonce ?? params.nonce ?? '')
    if (!nonce) return fail('missing_nonce'), true

    const token: ShellAssertion = {
      kind: 'atworkplace.account-hint',
      did: account.did,
      handle: account.handle,
      nonce,
    }
    json(res, 200, { token: JSON.stringify(token) }, fedcmCors(origin))
    return true
  }

  return false
}

// ---- shell's own API (same-origin, used by the shell page) ----------------

const api: Handler = async (req, res, url) => {
  if (!url.pathname.startsWith('/api/')) return false
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
    return json(res, 403, { error: 'same-origin only' }), true
  }

  let sid = sessionFor(req)
  const headers: Record<string, string> = {}
  if (!sid) {
    sid = randomBytes(16).toString('hex')
    store[sid] = []
    headers['set-cookie'] = sessionCookie(COOKIE, sid)
  }
  const accounts = store[sid]

  if (url.pathname === '/api/accounts' && req.method === 'GET') {
    return json(res, 200, { accounts }, { ...headers, ...loginStatus(accounts) }), true
  }

  if (url.pathname === '/api/accounts' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}')
    if (!isDid(body.did) || typeof body.handle !== 'string') {
      return json(res, 400, { error: 'did and handle required' }, headers), true
    }
    const next: ShellAccount = {
      did: body.did,
      handle: body.handle,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
    }
    store[sid] = [...accounts.filter((a) => a.did !== next.did), next]
    save()
    return json(res, 200, { accounts: store[sid] }, { ...headers, ...loginStatus(store[sid]) }), true
  }

  const m = url.pathname.match(/^\/api\/accounts\/(did:[^/]+)$/)
  if (m && req.method === 'DELETE') {
    const did = decodeURIComponent(m[1])
    store[sid] = accounts.filter((a) => a.did !== did)
    save()
    return json(res, 200, { accounts: store[sid] }, { ...headers, ...loginStatus(store[sid]) }), true
  }

  return json(res, 404, { error: 'not_found' }, headers), true
}

const statics: Handler = async (_req, res, url) => {
  // The shell page frames apps; only it decides what it may frame.
  const headers = { 'content-security-policy': `frame-src ${APP_ORIGIN} ${PDS_ORIGIN} https:` }
  if (url.pathname.startsWith('/dist/')) return serveStatic(res, join(root, 'dist', 'shell'), url.pathname.slice(6))
  return serveStatic(res, join(here, 'public'), url.pathname, headers)
}

export const start = () => startServer('shell', SHELL_PORT, [fedcm, api, statics])
