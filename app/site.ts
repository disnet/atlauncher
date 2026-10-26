// Demo app server: static files, its OAuth client metadata, and a one-time
// relay that carries OAuth redirect params from the (top-level,
// unpartitioned) popup back to the (framed, partitioned) app.
//
// Runtime-neutral: app/server.ts runs it under Node, deploy/ on Pages.

import { SHELL_ORIGIN } from '../lib/config.ts'
import { empty, isSameOrigin, json, readBody, type Handler, type Site } from '../lib/http.ts'
import type { Tables } from '../lib/store.ts'
import { CLIENT_METADATA_PATH, IS_LOOPBACK, clientMetadata } from './oauth-client.ts'

const RELAY_TTL_MS = 5 * 60_000
const KEY_RE = /^[0-9a-f-]{36}$/

export function appSite(tables: Tables): Site {
  const relay = tables<string>('app_relay')

  const relayHandler: Handler = async (req, url) => {
    const m = url.pathname.match(/^\/relay\/([^/]+)$/)
    if (!m) return
    const key = decodeURIComponent(m[1])
    if (!KEY_RE.test(key)) return json(400, { error: 'bad key' })
    if (!isSameOrigin(req)) return json(403, { error: 'same-origin only' })

    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 8192)) || '{}')
      if (typeof body.search !== 'string') return json(400, { error: 'search required' })
      if (!(await relay.add(key, body.search, RELAY_TTL_MS))) return json(409, { error: 'already relayed' })
      return json(200, { ok: true })
    }
    if (req.method === 'GET') {
      const search = await relay.take(key) // single read
      if (search === undefined) return empty(204)
      return json(200, { search })
    }
    return json(405, { error: 'method not allowed' })
  }

  const metadata: Handler = (_req, url) => {
    if (url.pathname !== CLIENT_METADATA_PATH || IS_LOOPBACK) return
    return json(200, clientMetadata(), { 'access-control-allow-origin': '*' })
  }

  return {
    name: 'app',
    handlers: [relayHandler, metadata],
    // The app agrees to be framed by atworkplace (constraint #1). The popup
    // callback page refuses framing, like any page that handles auth.
    assetHeaders: (pathname) => ({
      'content-security-policy': `frame-ancestors ${pathname.replace(/\.html$/, '') === '/callback' ? `'none'` : `'self' ${SHELL_ORIGIN}`}`,
    }),
  }
}
