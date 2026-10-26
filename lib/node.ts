// Runs a Site under Node's http server for local development and tests.

import { createServer, type IncomingMessage } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { dispatch, type Site } from './http.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/** URL prefix → directory. The first prefix that matches wins. */
export type StaticRoots = [prefix: string, dir: string][]

async function serveStatic(roots: StaticRoots, pathname: string): Promise<Response | undefined> {
  const root = roots.find(([prefix]) => pathname.startsWith(prefix))
  if (!root) return undefined
  const [prefix, dir] = root
  const rel = normalize(decodeURIComponent(pathname.slice(prefix.length - 1))).replace(/^(\.\.[/\\])+/, '')
  let file = join(dir, rel)
  if (!file.startsWith(dir)) return undefined
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    return new Response(await readFile(file), {
      headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' },
    })
  } catch {
    return undefined
  }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
  const headers = new Headers()
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
  let body: string | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    body = Buffer.concat(chunks).toString('utf8')
  }
  return new Request(url, { method: req.method, headers, body })
}

export function startServer(site: Site, port: number, roots: StaticRoots = []) {
  const server = createServer(async (req, res) => {
    const response = await dispatch(site, await toRequest(req), (_req, url) => serveStatic(roots, url.pathname))
    const headers: Record<string, string | string[]> = {}
    response.headers.forEach((v, k) => {
      if (k !== 'set-cookie') headers[k] = v
    })
    const cookies = response.headers.getSetCookie()
    if (cookies.length) headers['set-cookie'] = cookies
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  server.listen(port, () => console.log(`[${site.name}] listening on ${port}`))
  return server
}
