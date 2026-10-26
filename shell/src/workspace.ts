// Pure helpers for the shell's cross-app features: routing `open` requests,
// adding up unread counts and finding actions for an item. Kept free of the DOM so tests can run them.

import {
  acceptsItem,
  collectionOf,
  handlesCollection,
  isDid,
  type ActionDecl,
  type AtUri,
  type Did,
  type Item,
} from '../../protocol/messages.ts'

export interface RoutableFrame {
  id: string
  handles: readonly string[]
  active: Did | null
}

/**
 * Which open frame should show `uri`: one whose app handles the record's
 * collection, preferring a frame already showing `did`. Null when no open
 * frame handles it.
 */
export function pickFrame<F extends RoutableFrame>(frames: Iterable<F>, uri: AtUri, did?: Did): F | null {
  const collection = collectionOf(uri)
  if (!collection) return null
  const candidates = [...frames].filter((f) => handlesCollection(f.handles, collection))
  return candidates.find((f) => did && f.active === did) ?? candidates[0] ?? null
}

export interface UnreadReport {
  /** Frames of one origin share storage, so they report the same counts. */
  origin: string
  counts: ReadonlyMap<Did, number>
}

/** Unread per account across apps, counting each origin once. */
export function unreadByAccount(reports: Iterable<UnreadReport>): Map<Did, number> {
  const byOrigin = new Map<string, ReadonlyMap<Did, number>>()
  for (const r of reports) byOrigin.set(r.origin, r.counts)
  const totals = new Map<Did, number>()
  for (const counts of byOrigin.values()) {
    for (const [did, n] of counts) totals.set(did, (totals.get(did) ?? 0) + n)
  }
  return totals
}

export interface ActingFrame {
  origin: string
  active: Did | null
  actions: readonly ActionDecl[]
}

/**
 * The actions other apps offer for `item`, one entry per app origin and
 * action, never from the app that offered it. For an app open in several
 * frames, the first frame wins.
 */
export function actionsFor<F extends ActingFrame>(
  frames: Iterable<F>,
  item: Item,
  fromOrigin: string,
): { frame: F; action: ActionDecl }[] {
  const seen = new Set<string>()
  const out: { frame: F; action: ActionDecl }[] = []
  for (const frame of frames) {
    if (frame.origin === fromOrigin || seen.has(frame.origin)) continue
    seen.add(frame.origin)
    for (const action of frame.actions) if (acceptsItem(action.accepts, item)) out.push({ frame, action })
  }
  return out
}

// ---- the prototype's saved workspace -------------------------------------------

/** An app the user added to the prototype by URL. */
export interface SavedApp {
  id: string
  url: string
  /** From the app's `hello`, or the page title. */
  name?: string
  icon?: string
  /** Why the shell's server thinks the app refuses to be framed. */
  blocked?: string
}

/** What the prototype keeps per shell session: its apps and the chosen profile. */
export interface SavedWorkspace {
  apps: SavedApp[]
  profile: Did | null
}

export const MAX_APPS = 30

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined)

/** The URL as the shell will frame it, or null if it isn't an http(s) URL. */
export function appUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  // People type "bsky.app"; treat a bare host as https.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? u.href : null
  } catch {
    return null
  }
}

/** Validates a workspace sent by the page, dropping what doesn't fit. */
export function parseWorkspace(v: unknown): SavedWorkspace | null {
  if (!v || typeof v !== 'object') return null
  const { apps, profile } = v as Record<string, unknown>
  if (!Array.isArray(apps) || apps.length > MAX_APPS) return null
  const out: SavedApp[] = []
  for (const a of apps) {
    if (!a || typeof a !== 'object') return null
    const id = str(a.id, 64)
    const url = typeof a.url === 'string' && a.url.length <= 2048 ? appUrl(a.url) : null
    if (!id || !url) return null
    const name = str(a.name, 80)
    const icon = typeof a.icon === 'string' && a.icon.length <= 2048 ? appUrl(a.icon) : null
    const blocked = str(a.blocked, 300)
    out.push({ id, url, ...(name ? { name } : {}), ...(icon ? { icon } : {}), ...(blocked ? { blocked } : {}) })
  }
  if (profile != null && !isDid(profile)) return null
  return { apps: out, profile: profile ?? null }
}
