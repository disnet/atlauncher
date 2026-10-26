// Tiny HTTP helpers shared by the three servers. No framework, so the
// FedCM-specific headers are easy to see.
//
// Handlers use the Fetch API's Request and Response, so the same code runs
// under Node locally (lib/node.ts) and on Cloudflare Pages (deploy/).

export type Handler = (req: Request, url: URL) => Promise<Response | undefined> | Response | undefined

/** One origin's server: its routes, plus headers for the static files it serves. */
export interface Site {
  name: string
  handlers: Handler[]
  assetHeaders?: (pathname: string) => Record<string, string>
}

const JSON_TYPE = 'application/json; charset=utf-8'

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store', ...headers },
  })
}

export function html(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

export function empty(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

export async function readBody(req: Request, limit = 64 * 1024): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > limit) throw new Error('body too large')
  const text = await req.text()
  if (text.length > limit) throw new Error('body too large')
  return text
}

/** Parses an application/x-www-form-urlencoded or JSON body. */
export async function readParams(req: Request): Promise<Record<string, string>> {
  const raw = await readBody(req)
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const v = raw ? JSON.parse(raw) : {}
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]))
  }
  return Object.fromEntries(new URLSearchParams(raw))
}

export function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie')
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
export function isWebIdentityRequest(req: Request) {
  return req.headers.get('sec-fetch-dest') === 'webidentity'
}

/** False only when the browser says the request came from another origin. */
export function isSameOrigin(req: Request) {
  const site = req.headers.get('sec-fetch-site')
  return !site || site === 'same-origin'
}

/** CORS headers the assertion endpoint must send back to the relying party. */
export function fedcmCors(origin: string) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  }
}

/**
 * Runs a site's handlers in order. `fallback` serves static files (from disk
 * under Node, from Pages' asset store when deployed) and gets the site's
 * asset headers added.
 */
export async function dispatch(
  site: Site,
  req: Request,
  fallback?: (req: Request, url: URL) => Promise<Response | undefined>,
): Promise<Response> {
  const url = new URL(req.url)
  try {
    for (const h of site.handlers) {
      const res = await h(req, url)
      if (res) return res
    }
    const file = await fallback?.(req, url)
    if (file) {
      const res = new Response(file.body, file)
      for (const [k, v] of Object.entries(site.assetHeaders?.(url.pathname) ?? {})) res.headers.set(k, v)
      return res
    }
    return json(404, { error: 'not_found', path: url.pathname })
  } catch (err) {
    console.error(`[${site.name}]`, err)
    return json(500, { error: 'server_error', message: String(err) })
  }
}
