// The demo app that atworkplace frames.
//
// It works on its own (sign in by handle) and, when framed by the shell,
// speaks atworkplace/1: it reports its sessions and follows `switch` requests.

import { SHELL_ORIGIN } from '../../lib/config.ts'
import { PROTO, parseShellToApp, type AccountRef, type AppToShell, type Did } from '../../protocol/messages.ts'
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
  signOut,
  type SessionEntry,
} from './sessions.ts'

/** Only this shell may drive the app. A real app would make this a setting. */
const TRUSTED_SHELLS = [SHELL_ORIGIN]

const embedded = window.top !== window
const fedcm = 'IdentityCredential' in window

let sessions: SessionEntry[] = []
let active: Did | null = null
/** An account the user (or the shell) wants, that we don't have a session for. */
let pending: AccountRef | null = null

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
  log(`shell → ${msg.type}`, msg.type === 'switch' ? msg.account : msg.did)

  if (msg.type === 'switch') {
    const existing = sessions.find((s) => s.did === msg.account.did)
    if (existing) {
      await activate(existing.did)
    } else {
      // Signing in needs a click inside this frame (popup / FedCM rules).
      pending = msg.account
      render()
      toShell({ proto: PROTO, type: 'needs-sign-in', did: msg.account.did })
    }
  } else if (msg.type === 'sign-out') {
    const s = sessions.find((x) => x.did === msg.did)
    if (s) {
      await signOut(s)
      await reload()
    }
  }
})

// ---- state ---------------------------------------------------------------

async function reload() {
  sessions = await listSessions()
  active = await getActive()
  if (active && !sessions.some((s) => s.did === active)) active = null
  render()
  sendState()
  await renderProfile()
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
    li.append(label, kind, use, refresh, out)
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

$<HTMLButtonElement>('#via-mock').addEventListener('click', () =>
  run('asking mock PDS', () => signInWithMockPds()),
)

onLog((line) => {
  const pre = $<HTMLElement>('#log')
  pre.textContent += `${line}\n`
  pre.scrollTop = pre.scrollHeight
})

log('loaded', { embedded, fedcm, origin: location.origin })
await reload()
toShell({
  proto: PROTO,
  type: 'hello',
  app: { name: 'Demo app' },
  sessions: sessions.map((s) => s.did),
  active,
})
