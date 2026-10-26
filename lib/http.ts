// Tiny HTTP helpers shared by the three local servers. No framework, so the
// FedCM-specific headers are easy to see.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean | void> | boolean | void

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

export function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': MIME['.html'], 'cache-control': 'no-store', ...headers })
  res.end(body)
}

export async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parses an application/x-www-form-urlencoded or JSON body. */
export async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(req)
  const type = req.headers['content-type'] ?? ''
  if (type.includes('application/json')) {
    const v = raw ? JSON.parse(raw) : {}
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]))
  }
  return Object.fromEntries(new URLSearchParams(raw))
}

export function getCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

/**
 * FedCM sends the IdP's cookies to its accounts and assertion endpoints from
 * a cross-site context, so the session cookie must be SameSite=None; Secure.
 * Chrome treats http://localhost as a secure context, so Secure works there.
 */
export function sessionCookie(name: string, value: string) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=2592000`
}

/** True when the browser says this is a FedCM request. */
export function isWebIdentityRequest(req: IncomingMessage) {
  return req.headers['sec-fetch-dest'] === 'webidentity'
}

/** CORS headers the assertion endpoint must send back to the relying party. */
export function fedcmCors(origin: string) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  }
}

export async function serveStatic(res: ServerResponse, root: string, pathname: string, headers: Record<string, string> = {}) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(root, rel)
  if (!file.startsWith(root)) return false
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      ...headers,
    })
    res.end(body)
    return true
  } catch {
    return false
  }
}

export function startServer(name: string, port: number, handlers: Handler[]) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      for (const h of handlers) {
        if (await h(req, res, url)) return
      }
      json(res, 404, { error: 'not_found', path: url.pathname })
    } catch (err) {
      console.error(`[${name}]`, err)
      if (!res.headersSent) json(res, 500, { error: 'server_error', message: String(err) })
    }
  })
  server.listen(port, () => console.log(`[${name}] listening on ${port}`))
  return server
}
