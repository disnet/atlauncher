// The shell <-> framed app protocol ("atworkplace/1").
// See docs/PROTOCOL.md for the prose version.
//
// Design rules:
//  - The shell never holds an app's tokens. It only names accounts (by DID).
//  - Every message carries `proto` so either side can ignore unrelated
//    postMessage traffic (extensions, other libraries).
//  - Both sides check event.origin against an allowlist before acting.

export const PROTO = 'atworkplace/1' as const

export type Did = `did:${string}`

/** An `at://` URI naming a repo, a collection or a record. */
export type AtUri = `at://${string}`

/** An account as the shell knows it: a name, not a credential. */
export interface AccountRef {
  did: Did
  handle: string
}

// ---- app -> shell ---------------------------------------------------------

/** Sent once the app has loaded and restored its sessions. */
export interface HelloMessage {
  proto: typeof PROTO
  type: 'hello'
  app: { name: string }
  /** DIDs the app currently holds sessions for. */
  sessions: Did[]
  active: Did | null
  /**
   * Collections whose records this app can show, as NSIDs. A trailing `.*`
   * matches a whole namespace (`app.bsky.feed.*`). The shell routes `open`
   * requests for those collections to this app.
   */
  handles?: string[]
}

/** Sent whenever the app's sessions or active account change. */
export interface StateMessage {
  proto: typeof PROTO
  type: 'state'
  sessions: Did[]
  active: Did | null
}

/** Reply to a `switch` the app could not complete on its own. */
export interface NeedsSignInMessage {
  proto: typeof PROTO
  type: 'needs-sign-in'
  did: Did
}

/**
 * Unread counts per account, as a full snapshot: an account missing from
 * `counts` has none. The shell shows them as badges.
 */
export interface UnreadMessage {
  proto: typeof PROTO
  type: 'unread'
  counts: { did: Did; count: number }[]
}

/**
 * Ask the shell to show `uri` in whichever app handles its collection.
 * `did` is the account the user was using when they followed the link, so
 * the target app can show it as that account.
 */
export interface OpenRequestMessage {
  proto: typeof PROTO
  type: 'open'
  uri: AtUri
  did?: Did
}

export type AppToShell = HelloMessage | StateMessage | NeedsSignInMessage | UnreadMessage | OpenRequestMessage

// ---- shell -> app ---------------------------------------------------------

/**
 * Make `did` the active account. If the app has no session for it, the app
 * shows a "Continue as ..." prompt (sign-in needs a user gesture inside the
 * frame) and replies with `needs-sign-in`.
 */
export interface SwitchMessage {
  proto: typeof PROTO
  type: 'switch'
  account: AccountRef
}

/** Sign out one account inside the app. */
export interface SignOutMessage {
  proto: typeof PROTO
  type: 'sign-out'
  did: Did
}

/**
 * Show `uri`. Sent only to apps whose `hello` listed its collection. When
 * `account` is set the shell also wants the app to use that account, with
 * the same rules as `switch`.
 */
export interface OpenMessage {
  proto: typeof PROTO
  type: 'open'
  uri: AtUri
  account?: AccountRef
}

export type ShellToApp = SwitchMessage | SignOutMessage | OpenMessage

// ---- validation ----------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

export const isDid = (v: unknown): v is Did =>
  typeof v === 'string' && /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(v)

const isDidList = (v: unknown): v is Did[] =>
  Array.isArray(v) && v.every(isDid)

const NSID_RE = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+$/

/** A collection NSID, or a namespace pattern ending in `.*`. */
const isNsidPattern = (v: unknown): v is string =>
  typeof v === 'string' && NSID_RE.test(v.endsWith('.*') ? v.slice(0, -2) : v)

export const isAtUri = (v: unknown): v is AtUri =>
  typeof v === 'string' && /^at:\/\/[a-zA-Z0-9._:%-]+(\/[a-zA-Z0-9.-]+(\/[a-zA-Z0-9._:~-]+)?)?$/.test(v)

/** The collection an `at://` URI points into, or null for a bare repo. */
export function collectionOf(uri: AtUri): string | null {
  return uri.slice('at://'.length).split('/')[1] ?? null
}

/** Does an app that listed `patterns` in its `hello` handle `collection`? */
export function handlesCollection(patterns: readonly string[], collection: string): boolean {
  return patterns.some((p) =>
    p.endsWith('.*') ? collection.startsWith(p.slice(0, -1)) : p === collection,
  )
}

const isUnreadCounts = (v: unknown): v is UnreadMessage['counts'] =>
  Array.isArray(v) &&
  v.every((c) => isObj(c) && isDid(c.did) && Number.isInteger(c.count) && (c.count as number) >= 0)

const isAccountRef = (v: unknown): v is AccountRef =>
  isObj(v) && isDid(v.did) && typeof v.handle === 'string'

export function parseAppToShell(data: unknown): AppToShell | null {
  if (!isObj(data) || data.proto !== PROTO) return null
  switch (data.type) {
    case 'hello':
      return isObj(data.app) &&
        typeof data.app.name === 'string' &&
        isDidList(data.sessions) &&
        (data.active === null || isDid(data.active)) &&
        (data.handles === undefined || (Array.isArray(data.handles) && data.handles.every(isNsidPattern)))
        ? (data as unknown as HelloMessage)
        : null
    case 'state':
      return isDidList(data.sessions) &&
        (data.active === null || isDid(data.active))
        ? (data as unknown as StateMessage)
        : null
    case 'needs-sign-in':
      return isDid(data.did) ? (data as unknown as NeedsSignInMessage) : null
    case 'unread':
      return isUnreadCounts(data.counts) ? (data as unknown as UnreadMessage) : null
    case 'open':
      return isAtUri(data.uri) && (data.did === undefined || isDid(data.did))
        ? (data as unknown as OpenRequestMessage)
        : null
    default:
      return null
  }
}

export function parseShellToApp(data: unknown): ShellToApp | null {
  if (!isObj(data) || data.proto !== PROTO) return null
  switch (data.type) {
    case 'switch':
      return isAccountRef(data.account) ? (data as unknown as SwitchMessage) : null
    case 'sign-out':
      return isDid(data.did) ? (data as unknown as SignOutMessage) : null
    case 'open':
      return isAtUri(data.uri) && (data.account === undefined || isAccountRef(data.account))
        ? (data as unknown as OpenMessage)
        : null
    default:
      return null
  }
}

// ---- FedCM token payloads -------------------------------------------------

/**
 * Phase 1: what the shell's FedCM assertion endpoint returns (JSON string).
 * It is a *hint*, not proof of control: the app still runs real atproto
 * OAuth for that account, and the PDS decides.
 */
export interface ShellAssertion {
  kind: 'atworkplace.account-hint'
  did: Did
  handle: string
  nonce: string
}

/**
 * Phase 2: what a PDS-style authorization server's FedCM assertion endpoint
 * returns. The code is bound to the requesting app's client_id and to the
 * PKCE challenge the app sent in FedCM `params`, and is redeemed at
 * `token_endpoint` with the app's own DPoP key.
 */
export interface PdsAssertion {
  kind: 'atproto.oauth-code'
  code: string
  iss: string
  token_endpoint: string
  sub: Did
}

export function parseShellAssertion(token: string): ShellAssertion | null {
  try {
    const v = JSON.parse(token)
    return isObj(v) &&
      v.kind === 'atworkplace.account-hint' &&
      isDid(v.did) &&
      typeof v.handle === 'string' &&
      typeof v.nonce === 'string'
      ? (v as unknown as ShellAssertion)
      : null
  } catch {
    return null
  }
}

export function parsePdsAssertion(token: string): PdsAssertion | null {
  try {
    const v = JSON.parse(token)
    return isObj(v) &&
      v.kind === 'atproto.oauth-code' &&
      typeof v.code === 'string' &&
      typeof v.iss === 'string' &&
      typeof v.token_endpoint === 'string' &&
      isDid(v.sub)
      ? (v as unknown as PdsAssertion)
      : null
  } catch {
    return null
  }
}
