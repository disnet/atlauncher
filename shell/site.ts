// atworkplace shell server (Phase 1).
//
// Two jobs:
//  1. Serve the shell page that frames atproto apps.
//  2. Act as a FedCM identity provider whose "accounts" are the atproto
//     accounts the user has added to the shell. Its assertion is only a hint
//     ("the user picked did:plc:..."), never a credential: the framed app
//     still signs in with real atproto OAuth against that account's PDS.

import { base64url } from 'jose'
import { APP_ORIGIN, PDS_ORIGIN, SHELL_ORIGIN } from '../lib/config.ts'
import {
  fedcmCors,
  getCookie,
  isSameOrigin,
  isWebIdentityRequest,
  json,
  readBody,
  readParams,
  sessionCookie,
  type Handler,
  type Site,
} from '../lib/http.ts'
import type { Table, Tables } from '../lib/store.ts'
import { isDid, type ShellAssertion } from '../protocol/messages.ts'

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

/** FedCM Login Status API: tell the browser whether we have accounts. */
const loginStatus = (accounts: ShellAccount[]) =>
  ({ 'set-login': accounts.length ? 'logged-in' : 'logged-out' }) as Record<string, string>

const configUrl = `${SHELL_ORIGIN}/fedcm/config.json`

/** Session id → that browser's accounts. */
export const SHELL_TABLE = 'shell_accounts'

export function shellSite(tables: Tables): Site {
  const store: Table<ShellAccount[]> = tables(SHELL_TABLE)

  async function sessionFor(req: Request) {
    const sid = getCookie(req, COOKIE)
    const accounts = sid ? await store.get(sid) : undefined
    return sid && accounts ? { sid, accounts } : undefined
  }

  // ---- FedCM endpoints -----------------------------------------------------

  const fedcm: Handler = async (req, url) => {
    const p = url.pathname

    if (p === '/.well-known/web-identity') {
      // Chrome allows exactly one config URL here; listing the mock PDS's too
      // fails every FedCM call with "contains too many config URLs". Because
      // the IdP uses client_metadata, Chrome also wants accounts_endpoint and
      // login_url repeated here.
      return json(200, {
        provider_urls: [configUrl],
        accounts_endpoint: `${SHELL_ORIGIN}/fedcm/accounts`,
        login_url: `${SHELL_ORIGIN}/?fedcm-login=1`,
      })
    }

    if (p === '/fedcm/config.json') {
      return json(200, {
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
    }

    if (p === '/fedcm/client_metadata') {
      return json(200, {
        privacy_policy_url: `${SHELL_ORIGIN}/#privacy`,
        terms_of_service_url: `${SHELL_ORIGIN}/#terms`,
      })
    }

    if (p === '/fedcm/accounts') {
      if (!isWebIdentityRequest(req)) return json(400, { error: 'not a FedCM request' })
      const accounts = (await sessionFor(req))?.accounts ?? []
      if (!accounts.length) return json(401, { error: 'no accounts' }, loginStatus([]))
      return json(200, {
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
    }

    if (p === '/fedcm/assertion' && req.method === 'POST') {
      const origin = req.headers.get('origin') ?? ''
      if (!isWebIdentityRequest(req)) return json(400, { error: 'not a FedCM request' })
      const params = await readParams(req)
      const fail = (code: string, status = 400) =>
        json(status, { error: { code, url: `${SHELL_ORIGIN}/#error-${code}` } }, fedcmCors(origin))

      // client_id is the app's origin; the browser-supplied Origin must match.
      if (!APPROVED_APPS[origin]) return fail('unknown_client', 403)
      if (params.client_id !== origin) return fail('client_id_mismatch', 403)

      const account = (await sessionFor(req))?.accounts.find((a) => a.did === params.account_id)
      if (!account) return fail('unknown_account', 401)

      let rpParams: Record<string, unknown> = {}
      try {
        rpParams = params.params ? JSON.parse(params.params) : {}
      } catch {}
      const nonce = String(rpParams.nonce ?? params.nonce ?? '')
      if (!nonce) return fail('missing_nonce')

      const token: ShellAssertion = {
        kind: 'atworkplace.account-hint',
        did: account.did,
        handle: account.handle,
        nonce,
      }
      return json(200, { token: JSON.stringify(token) }, fedcmCors(origin))
    }
  }

  // ---- shell's own API (same-origin, used by the shell page) ----------------

  const api: Handler = async (req, url) => {
    if (!url.pathname.startsWith('/api/')) return
    if (!isSameOrigin(req)) return json(403, { error: 'same-origin only' })

    const session = await sessionFor(req)
    const headers: Record<string, string> = {}
    let sid = session?.sid
    const accounts = session?.accounts ?? []
    if (!sid) {
      sid = base64url.encode(crypto.getRandomValues(new Uint8Array(16)))
      await store.set(sid, [])
      headers['set-cookie'] = sessionCookie(COOKIE, sid)
    }
    const replace = async (next: ShellAccount[]) => {
      await store.set(sid, next)
      return json(200, { accounts: next }, { ...headers, ...loginStatus(next) })
    }

    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      return json(200, { accounts }, { ...headers, ...loginStatus(accounts) })
    }

    if (url.pathname === '/api/accounts' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (!isDid(body.did) || typeof body.handle !== 'string') {
        return json(400, { error: 'did and handle required' }, headers)
      }
      const next: ShellAccount = {
        did: body.did,
        handle: body.handle,
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
      }
      return replace([...accounts.filter((a) => a.did !== next.did), next])
    }

    const m = url.pathname.match(/^\/api\/accounts\/(did:[^/]+)$/)
    if (m && req.method === 'DELETE') {
      const did = decodeURIComponent(m[1])
      return replace(accounts.filter((a) => a.did !== did))
    }

    return json(404, { error: 'not_found' }, headers)
  }

  return {
    name: 'shell',
    handlers: [fedcm, api],
    // The shell page frames apps; only it decides what it may frame.
    assetHeaders: () => ({ 'content-security-policy': `frame-src ${APP_ORIGIN} ${PDS_ORIGIN} https:` }),
  }
}
