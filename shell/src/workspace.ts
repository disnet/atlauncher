// Pure helpers for the shell's cross-app features: routing `open` requests
// and adding up unread counts. Kept free of the DOM so tests can run them.

import { collectionOf, handlesCollection, type AtUri, type Did } from '../../protocol/messages.ts'

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
