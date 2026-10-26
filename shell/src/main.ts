// The atworkplace shell page.
//
// Holds a list of atproto accounts (names only) and a set of framed apps.
// Switching an account sends a `switch` message to frames; each app decides
// how to get a session for it. The shell never sees any app's tokens.

import {
  PROTO,
  parseAppToShell,
  type AccountRef,
  type Did,
  type ShellToApp,
} from '../../protocol/messages.ts'
import { APP_ORIGIN } from '../../lib/config.ts'

interface Account extends AccountRef {
  displayName?: string
  avatar?: string
}

interface Frame {
  id: string
  url: string
  origin: string
  el: HTMLElement
  iframe: HTMLIFrameElement
  appName: string
  sessions: Did[]
  active: Did | null
  pending: Did | null
  /** Account this frame showed before a reload; restored after its `hello`. */
  restore: Did | null
}

const $ = <T extends Element>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T

let accounts: Account[] = []
const FEDCM_LOGIN = new URLSearchParams(location.search).has('fedcm-login')
const frames = new Map<string, Frame>()

// ---- accounts ------------------------------------------------------------

async function loadAccounts() {
  const res = await fetch('/api/accounts', { credentials: 'same-origin' })
  accounts = (await res.json()).accounts
  renderAccounts()
}

/** Resolve a handle to DID + profile through the public AppView. */
async function lookupProfile(handle: string): Promise<Account> {
  const clean = handle.trim().replace(/^@/, '')
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(clean)}`,
  )
  if (!res.ok) throw new Error(`Couldn't find ${clean}`)
  const p = await res.json()
  return { did: p.did, handle: p.handle, displayName: p.displayName, avatar: p.avatar }
}

async function addAccount(handle: string) {
  const profile = await lookupProfile(handle)
  const res = await fetch('/api/accounts', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  })
  accounts = (await res.json()).accounts
  // Also tell the browser directly, in case the Set-Login header was missed.
  ;(navigator as any).login?.setStatus?.('logged-in')
  renderAccounts()
  // In the FedCM login popup, hand control back to the app's FedCM call.
  if (FEDCM_LOGIN) (window as any).IdentityProvider?.close?.()
}

async function removeAccount(did: Did) {
  const res = await fetch(`/api/accounts/${encodeURIComponent(did)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  accounts = (await res.json()).accounts
  if (!accounts.length) (navigator as any).login?.setStatus?.('logged-out')
  for (const f of frames.values()) send(f, { proto: PROTO, type: 'sign-out', did })
  renderAccounts()
}

function renderAccounts() {
  const ul = $<HTMLUListElement>('#accounts')
  ul.replaceChildren()
  for (const a of accounts) {
    const li = document.createElement('li')
    li.title = `Switch every frame to ${a.handle}`
    const avatar = a.avatar ? Object.assign(document.createElement('img'), { src: a.avatar, alt: '' }) : el('span', 'avatar')
    const who = el('div', 'who')
    who.append(text('div', a.displayName || a.handle), text('div', `@${a.handle}`, 'handle'))
    const rm = Object.assign(document.createElement('button'), { textContent: '×', title: `Remove ${a.handle}` })
    rm.addEventListener('click', (e) => {
      e.stopPropagation()
      removeAccount(a.did)
    })
    li.append(avatar, who, rm)
    li.addEventListener('click', () => {
      for (const f of frames.values()) switchFrame(f, a)
    })
    ul.append(li)
  }
  for (const f of frames.values()) renderFrame(f)
}

// ---- frames --------------------------------------------------------------

function openFrame(url: string, restore: Did | null = null, id = crypto.randomUUID()) {
  const tpl = $<HTMLTemplateElement>('#frame-tpl')
  const el = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement
  const iframe = $<HTMLIFrameElement>('iframe', el)
  const frame: Frame = {
    id,
    url,
    origin: new URL(url).origin,
    el,
    iframe,
    appName: new URL(url).host,
    sessions: [],
    active: null,
    pending: null,
    restore,
  }
  iframe.src = url
  $<HTMLButtonElement>('.close', el).addEventListener('click', () => {
    frames.delete(id)
    el.remove()
    saveFrames()
  })
  $<HTMLSelectElement>('.account-select', el).addEventListener('change', (e) => {
    const did = (e.target as HTMLSelectElement).value as Did
    const a = accounts.find((x) => x.did === did)
    if (a) switchFrame(frame, a)
  })
  frames.set(id, frame)
  $('#frames').append(el)
  renderFrame(frame)
  saveFrames()
}

function renderFrame(f: Frame) {
  $<HTMLElement>('.app-name', f.el).textContent = f.appName
  const select = $<HTMLSelectElement>('.account-select', f.el)
  select.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: 'Choose account…', disabled: true }),
    ...accounts.map((a) =>
      Object.assign(document.createElement('option'), {
        value: a.did,
        textContent: `${a.handle}${f.sessions.includes(a.did) ? ' ✓' : ''}`,
      }),
    ),
  )
  select.value = f.pending ?? f.active ?? ''
  const status = $<HTMLElement>('.status', f.el)
  if (f.pending && f.pending !== f.active) {
    status.textContent = 'sign-in needed in frame'
    status.className = 'status warn'
  } else if (f.active) {
    status.textContent = `${f.sessions.length} session${f.sessions.length === 1 ? '' : 's'}`
    status.className = 'status ok'
  } else {
    status.textContent = ''
    status.className = 'status'
  }
}

function send(f: Frame, msg: ShellToApp) {
  // Always target the frame's own origin so a navigated-away frame gets nothing.
  f.iframe.contentWindow?.postMessage(msg, f.origin)
}

function switchFrame(f: Frame, a: Account) {
  f.pending = a.did
  send(f, { proto: PROTO, type: 'switch', account: { did: a.did, handle: a.handle } })
  renderFrame(f)
}

window.addEventListener('message', (event) => {
  const frame = [...frames.values()].find((f) => f.iframe.contentWindow === event.source)
  if (!frame || event.origin !== frame.origin) return
  const msg = parseAppToShell(event.data)
  if (!msg) return
  switch (msg.type) {
    case 'hello': {
      frame.appName = msg.app.name
      frame.sessions = msg.sessions
      frame.active = msg.active
      // Frames of one app share storage, so the app's own "active" is
      // whatever any frame picked last. Which account *this* frame shows is
      // the shell's to remember.
      const want = frame.restore && accounts.find((a) => a.did === frame.restore)
      frame.restore = null
      if (want && want.did !== msg.active && msg.sessions.includes(want.did)) switchFrame(frame, want)
      break
    }
    case 'state':
      frame.sessions = msg.sessions
      frame.active = msg.active
      if (frame.pending === msg.active) frame.pending = null
      saveFrames()
      break
    case 'needs-sign-in':
      frame.pending = msg.did
      break
  }
  renderFrame(frame)
})

interface SavedFrame {
  url: string
  did: Did | null
}

function saveFrames() {
  const saved: SavedFrame[] = [...frames.values()].map((f) => ({ url: f.url, did: f.active ?? f.restore }))
  try {
    localStorage.setItem('awp.frames', JSON.stringify(saved))
  } catch {}
}

function restoreFrames(): SavedFrame[] {
  try {
    const v = JSON.parse(localStorage.getItem('awp.frames') ?? 'null')
    if (Array.isArray(v) && v.length) {
      // Older saves are plain URL strings.
      return v.flatMap((x): SavedFrame[] =>
        typeof x === 'string'
          ? [{ url: x, did: null }]
          : x && typeof x.url === 'string'
            ? [{ url: x.url, did: typeof x.did === 'string' && x.did.startsWith('did:') ? (x.did as Did) : null }]
            : [],
      )
    }
  } catch {}
  return [{ url: `${APP_ORIGIN}/`, did: null }]
}

// ---- helpers & boot ------------------------------------------------------

function el(tag: string, className?: string) {
  const e = document.createElement(tag)
  if (className) e.className = className
  return e
}
function text(tag: string, t: string, className?: string) {
  const e = el(tag, className)
  e.textContent = t
  return e
}

$<HTMLFormElement>('#add-account').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target as HTMLFormElement
  const input = form.elements.namedItem('handle') as HTMLInputElement
  try {
    await addAccount(input.value)
    input.value = ''
  } catch (err) {
    alert(String(err instanceof Error ? err.message : err))
  }
})

$<HTMLFormElement>('#add-frame').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = (e.target as HTMLFormElement).elements.namedItem('url') as HTMLInputElement
  try {
    openFrame(new URL(input.value).href)
    input.value = ''
  } catch {
    alert('Enter a full URL, like http://127.0.0.1:5171/')
  }
})
;($<HTMLInputElement>('#add-frame input')).value = `${APP_ORIGIN}/`

await loadAccounts()
if (FEDCM_LOGIN) {
  // The browser opened login_url (with ?fedcm-login=1) because an app asked
  // for an account and the shell had none. Don't open frames in this popup.
  $<HTMLElement>('#fedcm-login').hidden = false
} else {
  for (const f of restoreFrames()) openFrame(f.url, f.did)
}
