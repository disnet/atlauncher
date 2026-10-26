// The demo app's side of the workspace features: who this app is, unread
// counts to report, and the at:// records it can link to or show.
//
// Records are read from the public Bluesky AppView, so they work for any
// real account without signing in. Mock PDS accounts aren't on the public
// network, so their records can't be shown.

import type { AtUri, Did } from '../../protocol/messages.ts'
import { idbGet, idbSet } from './idb.ts'

const params = new URLSearchParams(location.search)

/**
 * The same demo app can run as several "apps" (`?name=Posts&handles=…`),
 * so the shell has more than one app to route links between.
 */
export const APP_NAME = params.get('name') ?? 'Demo app'
export const HANDLES = (params.get('handles') ?? '').split(',').filter(Boolean)

// ---- unread ----------------------------------------------------------------

// Frames of this app share storage, so simulated counts live in IndexedDB
// and a BroadcastChannel tells the other frames to report again. (A channel
// doesn't hear its own messages, so the frame that changed a count reports
// it itself.)
const unreadChannel = new BroadcastChannel('awp-unread')
const simKey = (did: Did) => `unread-sim:${did}`

export const getSimulatedUnread = async (did: Did) => (await idbGet<number>(simKey(did))) ?? 0

/** Dev aid: add to (or with null, clear) an account's simulated unread count. */
export async function bumpSimulatedUnread(did: Did, by: number | null) {
  await idbSet(simKey(did), by === null ? 0 : (await getSimulatedUnread(did)) + by)
  unreadChannel.postMessage('changed')
}

export function onUnreadChanged(fn: () => void) {
  unreadChannel.addEventListener('message', fn)
}

// ---- records ---------------------------------------------------------------

const APPVIEW = 'https://public.api.bsky.app/xrpc'

async function appview<T>(method: string, query: Record<string, string>): Promise<T> {
  const res = await fetch(`${APPVIEW}/${method}?${new URLSearchParams(query)}`)
  if (!res.ok) throw new Error(`${method} failed: ${res.status}`)
  return res.json()
}

export interface RecordLink {
  uri: AtUri
  label: string
}

/** Things the active account could link to: its profile and recent posts. */
export async function linksFor(did: Did): Promise<RecordLink[]> {
  const links: RecordLink[] = [{ uri: `at://${did}/app.bsky.actor.profile/self`, label: 'Profile' }]
  try {
    const { feed } = await appview<{ feed: { post: { uri: AtUri; record: { text?: string } } }[] }>(
      'app.bsky.feed.getAuthorFeed',
      { actor: did, limit: '5', filter: 'posts_no_replies' },
    )
    for (const { post } of feed) links.push({ uri: post.uri, label: post.record.text?.slice(0, 80) || '(no text)' })
  } catch {
    // Not on the public network (a mock account), or offline.
  }
  return links
}

export interface RecordView {
  title: string
  body: string
}

/** A short view of a post or profile record, from the public AppView. */
export async function viewRecord(uri: AtUri): Promise<RecordView> {
  const [, repo, collection] = uri.match(/^at:\/\/([^/]+)\/([^/]+)/) ?? []
  if (collection === 'app.bsky.feed.post') {
    const { posts } = await appview<{ posts: { author: { handle: string }; record: { text?: string } }[] }>(
      'app.bsky.feed.getPosts',
      { uris: uri },
    )
    if (!posts.length) throw new Error('Post not found')
    return { title: `Post by @${posts[0].author.handle}`, body: posts[0].record.text ?? '' }
  }
  if (collection === 'app.bsky.actor.profile') {
    const p = await appview<{ handle: string; displayName?: string; description?: string }>(
      'app.bsky.actor.getProfile',
      { actor: repo },
    )
    return { title: `${p.displayName || p.handle} (@${p.handle})`, body: p.description ?? '' }
  }
  throw new Error(`This app doesn't show ${collection} records`)
}
