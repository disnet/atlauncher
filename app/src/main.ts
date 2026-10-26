// The demo app that atworkplace frames.
//
// It works on its own (sign in by handle) and, when framed by the shell,
// speaks atworkplace/1: it reports its sessions and unread counts, follows
// `switch` requests, and passes at:// links to the shell to open.

import { SHELL_ORIGIN } from '../../lib/config.ts'
import {
  PROTO,
  isAtUri,
  parseShellToApp,
  type AccountRef,
  type AppToShell,
  type AtUri,
  type Did,
} from '../../protocol/messages.ts'
import { log, onLog } from './log.ts'
import {
  getActive,
  getProfile,
  listSessions,
  pickAccountViaShell,
  setActive,
  signInWithMockPds,
  signInWithPopup,
  forceRefresh,
  getUnreadCount,
  signOut,
  type SessionEntry,
} from './sessions.ts'
import {
  APP_NAME,
  HANDLES,
  bumpSimulatedUnread,
  getSimulatedUnread,
  linksFor,
  onUnreadChanged,
  viewRecord,
} from './workspace.ts'

/** Only this shell may drive the app. A real app would make this a setting. */
const TRUSTED_SHELLS = [SHELL_ORIGIN]

const embedded = window.top !== window
const fedcm = 'IdentityCredential' in window

let sessions: SessionEntry[] = []
let active: Did | null = null
/** An account the user (or the shell) wants, that we don't have a session for. */
let pending: AccountRef | null = null
/** Unread counts per account, as last reported to the shell. */
let unread = new Map<Did, number>()
/** Real notification counts, fetched on a timer, not on every render. */
const realUnread = new Map<Did, number>()

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T

// ---- talking to the shell ------------------------------------------------

function toShell(msg: AppToShell) {
  if (!embedded) return
  // targetOrigin makes the browser drop the message unless our parent really
  // is the trusted shell.
  for (const origin of TRUSTED_SHELLS) window.parent.postMessage(msg, origin)
}

const sendState = () =>
  toShell({ proto: PROTO, type: 'state', sessions: sessions.map((s) => s.did), active })

window.addEventListener('message', async (event) => {
  if (event.source !== window.parent || !TRUSTED_SHELLS.includes(event.origin)) return
  const msg = parseShellToApp(event.data)
  if (!msg) return
  log(`shell → ${msg.type}`, msg.type === 'switch' ? msg.account : msg.type === 'open' ? msg : msg.did)

  if (msg.type === 'switch') {
    await useAccount(msg.account)
  } else if (msg.type === 'open') {
    if (msg.account && msg.account.did !== active) await useAccount(msg.account)
    await showRecord(msg.uri)
  } else if (msg.type === 'sign-out') {
    const s = sessions.find((x) => x.did === msg.did)
    if (s) {
      await signOut(s)
      await reload()
    }
  }
})

/** Switch to `account`, or ask for a click to sign in to it. */
async function useAccount(account: AccountRef) {
  const existing = sessions.find((s) => s.did === account.did)
  if (existing) {
    await activate(existing.did)
  } else {
    // Signing in needs a click inside this frame (popup / FedCM rules).
    pending = account
    render()
    toShell({ proto: PROTO, type: 'needs-sign-in', did: account.did })
  }
}

// ---- workspace features ----------------------------------------------------

/** Send the shell a full snapshot of unread counts, if it changed. */
async function reportUnread() {
  const next = new Map<Did, number>()
  for (const s of sessions) {
    const n = (realUnread.get(s.did) ?? 0) + (await getSimulatedUnread(s.did))
    if (n) next.set(s.did, n)
  }
  const same = next.size === unread.size && [...next].every(([d, n]) => unread.get(d) === n)
  unread = next
  render()
  if (same) return
  toShell({ proto: PROTO, type: 'unread', counts: [...next].map(([did, count]) => ({ did, count })) })
}

async function pollRealUnread() {
  for (const s of sessions) {
    try {
      realUnread.set(s.did, await getUnreadCount(s))
    } catch (err) {
      log('unread count error (ignored)', String(err))
    }
  }
  await reportUnread()
}

/** Hand a link to the shell, which opens it in the app that handles it. */
function openInWorkspace(uri: AtUri) {
  log('open → shell', uri)
  toShell({ proto: PROTO, type: 'open', uri, ...(active ? { did: active } : {}) })
}

async function renderLinks() {
  const ul = $<HTMLUListElement>('#links')
  ul.replaceChildren()
  $<HTMLElement>('#links-section').hidden = !embedded
  if (!embedded || !active) return
  for (const link of await linksFor(active)) {
    const li = document.createElement('li')
    const label = Object.assign(document.createElement('span'), { textContent: link.label, title: link.uri })
    const open = Object.assign(document.createElement('button'), { textContent: 'Open', className: 'secondary' })
    open.addEventListener('click', () => openInWorkspace(link.uri))
    li.append(label, open)
    ul.append(li)
  }
}

async function showRecord(uri: AtUri) {
  const box = $<HTMLElement>('#opened')
  box.hidden = false
  $('#opened-uri').textContent = uri
  $('#opened-title').textContent = 'Loading…'
  $('#opened-body').textContent = ''
  try {
    const v = await viewRecord(uri)
    $('#opened-title').textContent = v.title
    $('#opened-body').textContent = v.body
  } catch (err) {
    $('#opened-title').textContent = err instanceof Error ? err.message : String(err)
  }
}

// ---- state ---------------------------------------------------------------

async function reload() {
  sessions = await listSessions()
  active = await getActive()
  if (active && !sessions.some((s) => s.did === active)) active = null
  render()
  sendState()
  await reportUnread()
  await Promise.all([renderProfile(), renderLinks()])
}

async function activate(did: Did) {
  await setActive(did)
  if (pending?.did === did) pending = null
  await reload()
}

async function run(label: string, fn: () => Promise<SessionEntry | void>) {
  setBusy(label)
  try {
    const entry = await fn()
    if (entry) await activate(entry.did)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`error: ${label}`, message)
    showError(message)
  } finally {
    setBusy(null)
  }
}

// ---- rendering -----------------------------------------------------------

function render() {
  $('#context').textContent = [
    embedded ? 'framed' : 'top level',
    embedded ? `referrer ${document.referrer ? new URL(document.referrer).origin : 'hidden'}` : null,
    fedcm ? 'FedCM available' : 'no FedCM in this browser',
    `${sessions.length} session${sessions.length === 1 ? '' : 's'} in this storage partition`,
  ]
    .filter(Boolean)
    .join(' · ')

  const banner = $<HTMLElement>('#pending')
  banner.hidden = !pending
  if (pending) {
    $('#pending-handle').textContent = `@${pending.handle}`
  }

  $<HTMLButtonElement>('#via-shell').hidden = !(embedded && fedcm)
  $<HTMLButtonElement>('#via-mock').hidden = !fedcm

  const ul = $<HTMLUListElement>('#sessions')
  ul.replaceChildren()
  for (const s of sessions) {
    const li = document.createElement('li')
    if (s.did === active) li.className = 'active'
    const label = document.createElement('span')
    label.textContent = `@${s.handle}`
    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = s.kind === 'mock' ? 'mock PDS' : 'atproto'
    const use = Object.assign(document.createElement('button'), { textContent: s.did === active ? 'Active' : 'Use' })
    use.disabled = s.did === active
    use.addEventListener('click', () => activate(s.did))
    const out = Object.assign(document.createElement('button'), { textContent: 'Sign out', className: 'secondary' })
    out.addEventListener('click', () => run('sign out', async () => {
      await signOut(s)
      await reload()
    }))
    // Dev aid: lets FINDINGS check token refresh across frames without
    // waiting for tokens to expire.
    const refresh = Object.assign(document.createElement('button'), {
      textContent: 'Refresh token',
      className: 'secondary',
      title: 'Dev: refresh this account\'s tokens now',
    })
    refresh.addEventListener('click', () => run(`refreshing ${s.handle}`, () => forceRefresh(s)))
    const count = unread.get(s.did)
    const badge = Object.assign(document.createElement('span'), {
      className: 'unread',
      textContent: count ? `${count} unread` : '',
    })
    // Dev aid: simulate notifications so badges can be tried with any account.
    const bump = Object.assign(document.createElement('button'), {
      textContent: '+1 unread',
      className: 'secondary',
      title: 'Dev: pretend this account got a notification',
    })
    bump.addEventListener('click', () => bumpSimulatedUnread(s.did, 1).then(reportUnread))
    const clear = Object.assign(document.createElement('button'), {
      textContent: 'Clear',
      className: 'secondary',
      title: 'Dev: clear simulated unread for this account',
    })
    clear.hidden = !count
    clear.addEventListener('click', () => bumpSimulatedUnread(s.did, null).then(reportUnread))
    li.append(label, kind, badge, use, bump, clear, refresh, out)
    ul.append(li)
  }
  if (!sessions.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'No accounts signed in here yet.'
    ul.append(li)
  }
}

async function renderProfile() {
  const card = $<HTMLElement>('#profile')
  const entry = sessions.find((s) => s.did === active)
  if (!entry) {
    card.hidden = true
    return
  }
  card.hidden = false
  $('#p-name').textContent = '…'
  try {
    const p = await getProfile(entry)
    ;($<HTMLImageElement>('#p-avatar')).src = p.avatar ?? ''
    $('#p-name').textContent = p.displayName || p.handle
    $('#p-handle').textContent = `@${p.handle}`
    $('#p-did').textContent = p.did
    $('#p-desc').textContent = p.description ?? ''
    $('#p-stats').textContent =
      p.followersCount === undefined ? '' : `${p.followersCount} followers · ${p.followsCount} following · ${p.postsCount} posts`
  } catch (err) {
    $('#p-name').textContent = 'Could not load profile'
    log('profile error', String(err))
  }
}

function setBusy(label: string | null) {
  document.body.classList.toggle('busy', !!label)
  $('#busy').textContent = label ? `${label}…` : ''
}

function showError(message: string) {
  const el = $<HTMLElement>('#error')
  el.textContent = message
  el.hidden = false
  setTimeout(() => (el.hidden = true), 6000)
}

// ---- wiring --------------------------------------------------------------

$<HTMLFormElement>('#by-handle').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = (e.target as HTMLFormElement).elements.namedItem('handle') as HTMLInputElement
  const handle = input.value.trim().replace(/^@/, '')
  if (!handle) return
  // signInWithPopup opens the window synchronously, inside this gesture.
  const p = signInWithPopup(handle)
  run(`signing in ${handle}`, () => p)
})

$<HTMLButtonElement>('#via-shell').addEventListener('click', () =>
  run('asking atworkplace', async () => {
    const hint = await pickAccountViaShell()
    const existing = sessions.find((s) => s.did === hint.did)
    if (existing) return existing
    // FedCM used up this click's user activation, so the OAuth popup needs
    // a second click. (Phase 2 removes this step.)
    pending = { did: hint.did, handle: hint.handle }
    render()
  }),
)

$<HTMLButtonElement>('#pending-continue').addEventListener('click', () => {
  if (!pending) return
  const p = signInWithPopup(pending.handle)
  run(`signing in ${pending.handle}`, () => p)
})

$<HTMLButtonElement>('#pending-dismiss').addEventListener('click', () => {
  pending = null
  render()
})

$<HTMLFormElement>('#open-uri').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = (e.target as HTMLFormElement).elements.namedItem('uri') as HTMLInputElement
  const uri = input.value.trim()
  if (!isAtUri(uri)) return showError('Enter an at:// URI, like at://did:plc:…/app.bsky.feed.post/…')
  openInWorkspace(uri)
})

$<HTMLButtonElement>('#via-mock').addEventListener('click', () =>
  run('asking mock PDS', () => signInWithMockPds()),
)

onLog((line) => {
  const pre = $<HTMLElement>('#log')
  pre.textContent += `${line}\n`
  pre.scrollTop = pre.scrollHeight
})

// Another frame of this app changed a simulated count.
onUnreadChanged(() => void reportUnread())

document.title = APP_NAME
$('#app-name').textContent = APP_NAME
log('loaded', { embedded, fedcm, origin: location.origin, handles: HANDLES })
await reload()
toShell({
  proto: PROTO,
  type: 'hello',
  app: { name: APP_NAME },
  sessions: sessions.map((s) => s.did),
  active,
  handles: HANDLES,
})
void pollRealUnread()
setInterval(pollRealUnread, 60_000)
