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

export type AppToShell = HelloMessage | StateMessage | NeedsSignInMessage

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

export type ShellToApp = SwitchMessage | SignOutMessage

// ---- validation ----------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

export const isDid = (v: unknown): v is Did =>
  typeof v === 'string' && /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(v)

const isDidList = (v: unknown): v is Did[] =>
  Array.isArray(v) && v.every(isDid)

const isAccountRef = (v: unknown): v is AccountRef =>
  isObj(v) && isDid(v.did) && typeof v.handle === 'string'

export function parseAppToShell(data: unknown): AppToShell | null {
  if (!isObj(data) || data.proto !== PROTO) return null
  switch (data.type) {
    case 'hello':
      return isObj(data.app) &&
        typeof data.app.name === 'string' &&
        isDidList(data.sessions) &&
        (data.active === null || isDid(data.active))
        ? (data as unknown as HelloMessage)
        : null
    case 'state':
      return isDidList(data.sessions) &&
        (data.active === null || isDid(data.active))
        ? (data as unknown as StateMessage)
        : null
    case 'needs-sign-in':
      return isDid(data.did) ? (data as unknown as NeedsSignInMessage) : null
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
