// Multi-account session registry for the demo app.
//
// Two kinds of session live side by side, both keyed by DID:
//  - "atproto": real accounts via @atproto/oauth-client-browser (Phase 1)
//  - "mock":    mock-PDS accounts obtained entirely through FedCM (Phase 2)
//
// Everything is stored in this origin's storage. When the app is framed
// cross-site, that storage is partitioned by the top-level site, so sessions
// made inside atworkplace are separate from sessions made at top level.

import { Agent } from '@atproto/api'
import { BrowserOAuthClient, type OAuthSession } from '@atproto/oauth-client-browser'
import { APP_ORIGIN, PDS_ORIGIN, SHELL_ORIGIN } from '../../lib/config.ts'
import { parsePdsAssertion, parseShellAssertion, type Did } from '../../protocol/messages.ts'
import { APPVIEW, CLIENT_ID, IS_LOOPBACK, REDIRECT_URI, SCOPE, clientMetadata } from '../oauth-client.ts'
import { dpopProof, generateDpopKey, pkcePair, type DpopKey } from './dpop.ts'
import { idbDel, idbGet, idbSet } from './idb.ts'
import { log } from './log.ts'

export interface Profile {
  did: Did
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  followersCount?: number
  followsCount?: number
  postsCount?: number
}

export interface SessionEntry {
  did: Did
  handle: string
  kind: 'atproto' | 'mock'
}

// ---- registry ------------------------------------------------------------

const LIST_KEY = 'sessions'
const ACTIVE_KEY = 'active'

export async function listSessions(): Promise<SessionEntry[]> {
  return (await idbGet<SessionEntry[]>(LIST_KEY)) ?? []
}
async function putSession(e: SessionEntry) {
  const list = (await listSessions()).filter((x) => x.did !== e.did)
  await idbSet(LIST_KEY, [...list, e])
}
async function dropSession(did: Did) {
  await idbSet(LIST_KEY, (await listSessions()).filter((x) => x.did !== did))
}
export const getActive = async () => (await idbGet<Did>(ACTIVE_KEY)) ?? null
export const setActive = (did: Did | null) => (did ? idbSet(ACTIVE_KEY, did) : idbDel(ACTIVE_KEY))

// ---- Phase 1: real atproto OAuth -----------------------------------------

/**
 * An Agent that names the AppView in atproto-proxy, so the PDS checks each
 * call against the matching `rpc:…?aud=` scope.
 */
function appviewAgent(session: OAuthSession) {
  const agent = new Agent(session)
  agent.configureProxy(APPVIEW)
  return agent
}

let clientP: Promise<BrowserOAuthClient> | undefined
export function oauthClient() {
  // Loopback locally; deployed, the metadata the app server publishes.
  clientP ??= IS_LOOPBACK
    ? BrowserOAuthClient.load({ clientId: CLIENT_ID, handleResolver: 'https://bsky.social', responseMode: 'query' })
    : Promise.resolve(
        new BrowserOAuthClient({
          clientMetadata: clientMetadata(),
          handleResolver: 'https://bsky.social',
          responseMode: 'query',
        }),
      )
  return clientP
}

/**
 * Asks the shell (as a FedCM IdP) which account to use. Returns a hint only;
 * the caller must still run OAuth for that account.
 */
export async function pickAccountViaShell(loginHint?: string) {
  const nonce = crypto.randomUUID()
  log('FedCM → atworkplace shell', { loginHint })
  const cred = (await navigator.credentials.get({
    identity: {
      mode: 'active',
      providers: [
        {
          configURL: `${SHELL_ORIGIN}/fedcm/config.json`,
          clientId: APP_ORIGIN,
          params: { nonce },
          ...(loginHint ? { loginHint } : {}),
        },
      ],
    },
  } as CredentialRequestOptions)) as (Credential & { token: string }) | null
  if (!cred) throw new Error('No account chosen')
  const hint = parseShellAssertion(cred.token)
  if (!hint || hint.nonce !== nonce) throw new Error('Shell returned an unexpected token')
  log('FedCM token from shell', hint)
  return hint
}

/**
 * Opens the popup *synchronously* (must be called directly from a click),
 * then points it at the authorization URL once that's ready.
 *
 * The callback page can't use window.opener (the auth server's COOP may sever
 * it) or BroadcastChannel (partitioned: the popup is top-level, this frame is
 * not). So it posts the callback params to our own server under a one-time
 * relay key, and this frame polls for them. The params are useless without
 * the PKCE verifier and DPoP key, which only this frame's storage holds.
 */
export function signInWithPopup(handle: string): Promise<SessionEntry> {
  const relayKey = crypto.randomUUID()
  const popup = window.open(
    `${APP_ORIGIN}/callback.html#relay=${relayKey}`,
    `atproto-oauth-${relayKey}`,
    'popup,width=520,height=720',
  )
  if (!popup) return Promise.reject(new Error('Popup blocked'))

  return (async () => {
    const client = await oauthClient()
    const url = await client.authorize(handle, {
      scope: SCOPE,
      redirect_uri: REDIRECT_URI,
      prompt: 'select_account',
    })
    log('authorize → popup', { handle })
    popup.location.href = url.href

    const params = await waitForRelay(relayKey, popup)
    const { session } = await client.callback(params, { redirect_uri: REDIRECT_URI })
    return finishAtproto(session)
  })().catch((err) => {
    if (!popup.closed) popup.close()
    throw err
  })
}

async function waitForRelay(key: string, popup: Window): Promise<URLSearchParams> {
  const deadline = Date.now() + 5 * 60_000
  // Also accept a direct postMessage, in case the opener link survived.
  let viaMessage: string | undefined
  let closedLogged = false
  const onMessage = (e: MessageEvent) => {
    if (e.origin === APP_ORIGIN && e.data?.type === 'oauth-callback' && e.data.relay === key) {
      viaMessage = e.data.search
    }
  }
  window.addEventListener('message', onMessage)
  try {
    while (Date.now() < deadline) {
      if (viaMessage) {
        log('callback via postMessage')
        return new URLSearchParams(viaMessage)
      }
      const res = await fetch(`/relay/${key}`, { cache: 'no-store' })
      if (res.status === 200) {
        log('callback via server relay')
        return new URLSearchParams((await res.json()).search)
      }
      // Don't give up when the popup looks closed: once it navigates to an
      // auth server that sends COOP, Chrome swaps its browsing context group
      // and our handle reports closed=true while sign-in is still going on.
      // The relay (or the deadline) is the only reliable signal.
      if (popup.closed && !closedLogged) {
        closedLogged = true
        log('popup handle reports closed (COOP?); still waiting for relay')
      }
      await new Promise((r) => setTimeout(r, 700))
    }
    throw new Error('Sign-in timed out')
  } finally {
    window.removeEventListener('message', onMessage)
  }
}

async function finishAtproto(session: OAuthSession): Promise<SessionEntry> {
  const agent = appviewAgent(session)
  const { data } = await agent.getProfile({ actor: session.did })
  const entry: SessionEntry = { did: session.did as Did, handle: data.handle, kind: 'atproto' }
  await putSession(entry)
  log('signed in (atproto)', entry)
  return entry
}

// ---- Phase 2: mock PDS as FedCM IdP --------------------------------------

interface MockStored {
  key: DpopKey
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenEndpoint: string
  iss: string
}

/** One click, no popup: FedCM returns an OAuth code bound to our DPoP key. */
export async function signInWithMockPds(loginHint?: string): Promise<SessionEntry> {
  const key = await generateDpopKey()
  const pkce = await pkcePair()
  const nonce = crypto.randomUUID()
  log('FedCM → mock PDS', { loginHint, dpop_jkt: key.jkt })
  const cred = (await navigator.credentials.get({
    identity: {
      mode: 'active',
      providers: [
        {
          configURL: `${PDS_ORIGIN}/fedcm/config.json`,
          clientId: APP_ORIGIN,
          params: {
            nonce,
            scope: 'atproto',
            code_challenge: pkce.challenge,
            code_challenge_method: 'S256',
            dpop_jkt: key.jkt,
          },
          ...(loginHint ? { loginHint } : {}),
        },
      ],
    },
  } as CredentialRequestOptions)) as (Credential & { token: string }) | null
  if (!cred) throw new Error('No account chosen')
  const a = parsePdsAssertion(cred.token)
  if (!a) throw new Error('Mock PDS returned an unexpected token')
  if (new URL(a.token_endpoint).origin !== new URL(a.iss).origin) throw new Error('token_endpoint not on issuer')
  log('FedCM token from mock PDS (an OAuth code)', { sub: a.sub, iss: a.iss })

  const res = await fetch(a.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      DPoP: await dpopProof(key, 'POST', a.token_endpoint),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: a.code,
      code_verifier: pkce.verifier,
      client_id: APP_ORIGIN,
    }),
  })
  const tok = await res.json()
  if (!res.ok) throw new Error(`Token exchange failed: ${tok.error ?? res.status}`)
  if (tok.sub !== a.sub) throw new Error('Token sub mismatch')

  const stored: MockStored = {
    key,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + tok.expires_in * 1000,
    tokenEndpoint: a.token_endpoint,
    iss: a.iss,
  }
  await idbSet(`mock:${a.sub}`, stored)
  const profile = await mockGetProfile(a.sub)
  const entry: SessionEntry = { did: a.sub, handle: profile.handle, kind: 'mock' }
  await putSession(entry)
  log('signed in (mock PDS)', entry)
  return entry
}

async function mockFetch(did: Did, url: string): Promise<Response> {
  let s = await idbGet<MockStored>(`mock:${did}`)
  if (!s) throw new Error('No mock session')
  if (Date.now() > s.expiresAt - 30_000) s = await mockRefresh(did, s)
  return fetch(url, {
    headers: {
      authorization: `DPoP ${s.accessToken}`,
      DPoP: await dpopProof(s.key, 'GET', url, s.accessToken),
    },
  })
}

// Frames of the app share one partition, so two of them can try to refresh
// the same session at once. Refresh tokens rotate, so the loser's token is
// already spent: take a cross-frame lock and re-read the stored session
// inside it (the atproto library does the same with navigator.locks).
async function mockRefresh(did: Did, seen: MockStored): Promise<MockStored> {
  return navigator.locks.request(`mock-refresh:${did}`, async () => {
    const s = await idbGet<MockStored>(`mock:${did}`)
    if (!s) throw new Error('No mock session')
    if (s.refreshToken !== seen.refreshToken) {
      log('another frame already refreshed', { did })
      return s
    }
    return mockRefreshLocked(did, s)
  })
}

async function mockRefreshLocked(did: Did, s: MockStored): Promise<MockStored> {
  const res = await fetch(s.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: await dpopProof(s.key, 'POST', s.tokenEndpoint) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: APP_ORIGIN }),
  })
  const tok = await res.json()
  if (!res.ok) throw new Error(`Refresh failed: ${tok.error ?? res.status}`)
  const next = { ...s, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + tok.expires_in * 1000 }
  await idbSet(`mock:${did}`, next)
  log('refreshed mock token', { did })
  return next
}

async function mockGetProfile(did: Did): Promise<Profile> {
  const res = await mockFetch(did, `${PDS_ORIGIN}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`)
  if (!res.ok) throw new Error(`getProfile failed: ${res.status}`)
  return res.json()
}

// ---- common ---------------------------------------------------------------

export async function getProfile(e: SessionEntry): Promise<Profile> {
  if (e.kind === 'mock') return mockGetProfile(e.did)
  const client = await oauthClient()
  const session = await client.restore(e.did)
  const { data } = await appviewAgent(session).getProfile({ actor: e.did })
  return data as Profile
}

/**
 * Unread Bluesky notifications for a real account, through its PDS. Mock
 * PDS accounts have no notifications, so they report 0.
 */
export async function getUnreadCount(e: SessionEntry): Promise<number> {
  if (e.kind === 'mock') return 0
  const session = await (await oauthClient()).restore(e.did)
  const { data } = await appviewAgent(session).app.bsky.notification.getUnreadCount()
  return data.count
}

/**
 * Dev aid for FINDINGS: refresh this account's tokens now instead of waiting
 * for them to expire, then make an authenticated call with the new ones.
 * Run it in one frame, then the other, to see whether frames that share a
 * partition pick up each other's rotated refresh token.
 */
export async function forceRefresh(e: SessionEntry) {
  if (e.kind === 'mock') {
    const s = await idbGet<MockStored>(`mock:${e.did}`)
    if (!s) throw new Error('No mock session')
    const next = await mockRefresh(e.did, s)
    await mockGetProfile(e.did)
    log('forced refresh (mock PDS), profile call ok', { did: e.did, expiresAt: new Date(next.expiresAt).toISOString() })
    return
  }
  const session = await (await oauthClient()).restore(e.did, false)
  const before = await session.getTokenInfo(false)
  const after = await session.getTokenInfo(true)
  await appviewAgent(session).getProfile({ actor: e.did })
  log('forced refresh (atproto), profile call ok', {
    did: e.did,
    expiresBefore: before.expiresAt?.toISOString(),
    expiresAfter: after.expiresAt?.toISOString(),
  })
}

export async function signOut(e: SessionEntry) {
  try {
    if (e.kind === 'atproto') await (await oauthClient()).revoke(e.did)
    else await idbDel(`mock:${e.did}`)
  } catch (err) {
    log('sign-out error (ignored)', String(err))
  }
  await dropSession(e.did)
  if ((await getActive()) === e.did) await setActive(null)
}
