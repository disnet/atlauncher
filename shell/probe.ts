// Checks, from the server, whether a page will let the shell frame it.
//
// A cross-origin frame that refuses to load (X-Frame-Options or CSP
// frame-ancestors) looks to the embedding page just like one that loaded:
// `load` fires and the frame is opaque either way. So before framing an app
// added by URL, the shell asks its own server to fetch the page and read
// those headers, plus a title and icon for the sidebar. The answer is a
// best guess: headers can differ per request, and a failed fetch says
// nothing about framing.

export interface Probe {
  /** Final URL after redirects. */
  url: string
  /** false: the headers refuse the shell. null: couldn't tell. */
  frameable: boolean | null
  reason?: string
  title?: string
  icon?: string
}

/**
 * Does a response with these headers, from `appOrigin`, allow being framed
 * by a page on `shellOrigin`? CSP frame-ancestors wins over X-Frame-Options
 * when both are present, as in browsers.
 */
export function framingVerdict(
  headers: Headers,
  appOrigin: string,
  shellOrigin: string,
): { frameable: boolean; reason?: string } {
  const sameOrigin = appOrigin === shellOrigin
  const ancestors = frameAncestors(headers.get('content-security-policy'))
  if (ancestors) {
    if (ancestors.some((s) => sourceMatches(s, shellOrigin, appOrigin))) return { frameable: true }
    return { frameable: false, reason: `Content-Security-Policy: frame-ancestors ${ancestors.join(' ') || "'none'"}` }
  }
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase()
  if (xfo === 'deny') return { frameable: false, reason: 'X-Frame-Options: DENY' }
  if (xfo === 'sameorigin' && !sameOrigin) return { frameable: false, reason: 'X-Frame-Options: SAMEORIGIN' }
  return { frameable: true }
}

/** The frame-ancestors sources across every policy in the header, or null if none sets it. */
function frameAncestors(csp: string | null): string[] | null {
  if (!csp) return null
  // Several policies may be joined with commas; each one must allow framing.
  // Returning the sources of the first that sets frame-ancestors is enough
  // for a prototype.
  for (const policy of csp.split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/)
      if (name?.toLowerCase() === 'frame-ancestors') {
        return sources.filter((s) => s.toLowerCase() !== "'none'")
      }
    }
  }
  return null
}

function sourceMatches(source: string, origin: string, appOrigin: string): boolean {
  const s = source.toLowerCase()
  const o = new URL(origin)
  if (s === '*') return true
  if (s === "'self'") return origin === appOrigin
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return o.protocol === s || (s === 'http:' && o.protocol === 'https:')
  const m = s.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^:/]+)(?::(\d+|\*))?/)
  if (!m) return false
  const [, scheme, wildcard, host, port] = m
  if (scheme && scheme !== o.protocol.slice(0, -1) && !(scheme === 'http' && o.protocol === 'https:')) return false
  if (wildcard ? !o.hostname.endsWith(`.${host}`) : o.hostname !== host) return false
  const defaultPort = o.protocol === 'https:' ? '443' : '80'
  if (port !== '*' && (port ?? defaultPort) !== (o.port || defaultPort)) return false
  return true
}

/** Fetch `url` and report whether `shellOrigin` may frame it. */
export async function probe(url: string, shellOrigin: string): Promise<Probe> {
  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { accept: 'text/html,*/*;q=0.8' },
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    return { url, frameable: null, reason: `Couldn't fetch it from the shell's server (${errorText(err)})` }
  }
  const final = res.url || url
  const appOrigin = new URL(final).origin
  const fallbackIcon = `${appOrigin}/favicon.ico`
  // Cloudflare answers some fetches between Workers on workers.dev with its
  // own error page, so a failure here isn't the app's answer.
  if (!res.ok) {
    void res.body?.cancel().catch(() => {})
    return { url: final, frameable: null, reason: `The shell's server got HTTP ${res.status}`, icon: fallbackIcon }
  }
  const verdict = framingVerdict(res.headers, appOrigin, shellOrigin)
  let page = ''
  if ((res.headers.get('content-type') ?? '').includes('html')) page = await head(res)
  else void res.body?.cancel().catch(() => {})
  const info = pageInfo(page, final)
  return { url: final, ...verdict, ...info, icon: info.icon ?? fallbackIcon }
}

/** The first 64 KB of the body, enough for <head>. */
async function head(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < 64 * 1024) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  void reader.cancel().catch(() => {})
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return new TextDecoder().decode(all)
}

/** Title and icon from a page's <head>. Regexes, not a parser: it's a hint. */
export function pageInfo(page: string, base: string): { title?: string; icon?: string } {
  const title = page.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()
  let icon: string | undefined
  for (const link of page.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(link, 'rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attr(link, 'href')
    if (!href || !(rel.includes('icon') || rel.includes('apple-touch-icon'))) continue
    try {
      const u = new URL(decodeEntities(href), base)
      if (u.protocol === 'https:' || u.protocol === 'http:') icon = u.href
    } catch {}
    if (icon && rel.includes('apple-touch-icon')) break // bigger, looks better in the rail
  }
  return { ...(title ? { title: decodeEntities(title).slice(0, 80) } : {}), ...(icon ? { icon } : {}) }
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function errorText(err: unknown) {
  return err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err)
}
