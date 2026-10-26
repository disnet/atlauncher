// Demo app server: static files, plus a one-time relay that carries OAuth
// redirect params from the (top-level, unpartitioned) popup back to the
// (framed, partitioned) app.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_PORT, SHELL_ORIGIN } from '../lib/config.ts'
import { json, readBody, serveStatic, startServer, type Handler } from '../lib/http.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const RELAY_TTL_MS = 5 * 60_000
const relay = new Map<string, { search: string; expires: number }>()
const KEY_RE = /^[0-9a-f-]{36}$/

export const relayHandler: Handler = async (req, res, url) => {
  const m = url.pathname.match(/^\/relay\/([^/]+)$/)
  if (!m) return false
  const key = decodeURIComponent(m[1])
  if (!KEY_RE.test(key)) return json(res, 400, { error: 'bad key' }), true
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
    return json(res, 403, { error: 'same-origin only' }), true
  }
  const now = Date.now()
  for (const [k, v] of relay) if (v.expires < now) relay.delete(k)

  if (req.method === 'POST') {
    if (relay.has(key)) return json(res, 409, { error: 'already relayed' }), true
    const body = JSON.parse((await readBody(req, 8192)) || '{}')
    if (typeof body.search !== 'string') return json(res, 400, { error: 'search required' }), true
    relay.set(key, { search: body.search, expires: now + RELAY_TTL_MS })
    return json(res, 200, { ok: true }), true
  }
  if (req.method === 'GET') {
    const v = relay.get(key)
    if (!v) return res.writeHead(204, { 'cache-control': 'no-store' }).end(), true
    relay.delete(key) // single read
    return json(res, 200, { search: v.search }), true
  }
  return json(res, 405, { error: 'method not allowed' }), true
}

const statics: Handler = async (_req, res, url) => {
  if (url.pathname.startsWith('/dist/')) return serveStatic(res, join(root, 'dist', 'app'), url.pathname.slice(6))
  // The app agrees to be framed by atworkplace (constraint #1). The popup
  // callback page refuses framing, like any page that handles auth.
  const ancestors = url.pathname === '/callback.html' ? `'none'` : `'self' ${SHELL_ORIGIN}`
  return serveStatic(res, join(here, 'public'), url.pathname, {
    'content-security-policy': `frame-ancestors ${ancestors}`,
  })
}

export const start = () => startServer('app', APP_PORT, [relayHandler, statics])
