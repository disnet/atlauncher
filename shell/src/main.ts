// The atworkplace shell page.
//
// Holds a list of atproto accounts (names only) and a set of framed apps.
// Switching an account sends a `switch` message to frames; each app decides
// how to get a session for it. The shell never sees any app's tokens.

import {
  PROTO,
  parseAppToShell,
  collectionOf,
  handlesCollection,
  type AccountRef,
  type ActionDecl,
  type AtUri,
  type Did,
  type Item,
  type OpenMessage,
  type ShellToApp,
} from '../../protocol/messages.ts'
import { APP_ORIGIN, MOCK_ORIGINS } from '../../lib/config.ts'
import { actionsFor, pickFrame, unreadByAccount } from './workspace.ts'

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
  /** Collections the app said it can show. */
  handles: string[]
  /** What the app can do with items from other apps. */
  actions: ActionDecl[]
  unread: Map<Did, number>
  /** An `open` to deliver once the frame has said `hello`. */
  queuedOpen: OpenMessage | null
  ready: boolean
}

/** Apps the shell has seen, so it can open one to show a link. */
interface KnownApp {
  url: string
  name: string
  handles: string[]
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
    const name = text('div', a.displayName || a.handle)
    const unread = unreadTotals().get(a.did)
    if (unread) name.append(' ', badge(unread, `${unread} unread across apps`))
    who.append(name, text('div', `@${a.handle}`, 'handle'))
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

function openFrame(url: string, restore: Did | null = null, id = crypto.randomUUID()): Frame {
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
    handles: [],
    actions: [],
    unread: new Map(),
    queuedOpen: null,
    ready: false,
  }
  iframe.src = url
  $<HTMLButtonElement>('.close', el).addEventListener('click', () => closeFrame(frame))
  $<HTMLSelectElement>('.account-select', el).addEventListener('change', (e) => {
    const did = (e.target as HTMLSelectElement).value as Did
    const a = accounts.find((x) => x.did === did)
    if (a) switchFrame(frame, a)
  })
  frames.set(id, frame)
  $('#frames').append(el)
  renderFrame(frame)
  saveFrames()
  return frame
}

function closeFrame(f: Frame) {
  frames.delete(f.id)
  f.el.remove()
  if (focus?.from === f) setFocus(f, null)
  saveFrames()
  renderAccounts()
}

function renderFrame(f: Frame) {
  const name = $<HTMLElement>('.app-name', f.el)
  name.textContent = f.appName
  const shown = f.pending ?? f.active
  const unread = shown ? f.unread.get(shown) : 0
  if (unread) name.append(' ', badge(unread, `${unread} unread for this account`))
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

function unreadTotals() {
  return unreadByAccount([...frames.values()].map((f) => ({ origin: f.origin, counts: f.unread })))
}

/**
 * Show an `at://` link in the app that handles it: an open frame if there
 * is one, else a new frame of an app seen before.
 */
function routeOpen(uri: AtUri, did: Did | undefined, from: Frame) {
  const account = did && accounts.find((a) => a.did === did)
  const msg: OpenMessage = {
    proto: PROTO,
    type: 'open',
    uri,
    ...(account ? { account: { did: account.did, handle: account.handle } } : {}),
  }
  let target = pickFrame(frames.values(), uri, did)
  if (!target) {
    const collection = collectionOf(uri)
    const app = collection && knownApps().find((a) => handlesCollection(a.handles, collection))
    if (!app) {
      notice(`No app in this workspace opens ${collection ?? 'whole repos'}.`, from)
      return
    }
    target = openFrame(app.url, did ?? null)
  }
  if (account && target.active !== account.did) target.pending = account.did
  if (target.ready) send(target, msg)
  else target.queuedOpen = msg
  renderFrame(target)
  if (target !== from) flash(target)
}

function notice(message: string, f: Frame) {
  const n = $<HTMLElement>('.notice', f.el)
  n.textContent = message
  n.hidden = false
  setTimeout(() => (n.hidden = true), 5000)
}

// ---- shared actions ---------------------------------------------------------

/**
 * Offer `item` from frame `from` to the other apps' actions: a sheet lists
 * the actions that accept it, and the chosen app gets `perform`.
 */
function offerItem(item: Item, did: Did | undefined, from: Frame) {
  const options = actionsFor([...frames.values()], item, from.origin)
  const dialog = $<HTMLDialogElement>('#act-sheet')
  $<HTMLElement>('.act-title', dialog).textContent = item.title
  $<HTMLElement>('.act-text', dialog).textContent = item.text ?? ''
  const list = $<HTMLUListElement>('.act-options', dialog)
  list.replaceChildren()
  if (!options.length) list.append(text('li', 'No app in this workspace takes this.', 'hint'))
  for (const { frame, action } of options) {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.append(text('span', action.label), text('span', frame.appName, 'act-app'))
    b.addEventListener('click', () => {
      dialog.close()
      perform(frame, action.id, item, did)
    })
    li.append(b)
    list.append(li)
  }
  dialog.showModal()
}

function perform(target: Frame, action: string, item: Item, did: Did | undefined) {
  // Act as the account the user was using, with the same rules as `switch`.
  const account = did && accounts.find((a) => a.did === did)
  send(target, {
    proto: PROTO,
    type: 'perform',
    action,
    item,
    ...(account ? { account: { did: account.did, handle: account.handle } } : {}),
  })
  if (account && target.active !== account.did) target.pending = account.did
  renderFrame(target)
  flash(target)
  // An action usually adds something "about" the focused item (a note, a
  // message), so ask again once the app has had a moment to save it.
  setTimeout(queryContext, 400)
}

// ---- what links here ---------------------------------------------------------

interface Focus {
  from: Frame
  item: Item
  query: string
  /** Answers per app origin, so two frames of one app count once. */
  answers: Map<string, { appName: string; frame: Frame; items: Item[] }>
}
let focus: Focus | null = null

function setFocus(from: Frame, item: Item | null) {
  if (!item) {
    if (focus?.from === from) focus = null
    renderContext()
    return
  }
  focus = { from, item, query: '', answers: new Map() }
  queryContext()
}

/** Ask every other app what it has about the focused item. */
function queryContext() {
  if (!focus) return
  focus.query = crypto.randomUUID()
  focus.answers.clear()
  for (const f of frames.values()) {
    if (f.origin === focus.from.origin || !f.ready) continue
    send(f, {
      proto: PROTO,
      type: 'context-query',
      query: focus.query,
      item: focus.item,
      ...(f.active ? { did: f.active } : {}),
    })
  }
  renderContext()
}

function renderContext() {
  const section = $<HTMLElement>('#context')
  section.hidden = !focus
  if (!focus) return
  $<HTMLElement>('.context-title', section).textContent = focus.item.title
  const list = $<HTMLUListElement>('.context-items', section)
  list.replaceChildren()
  const answers = [...focus.answers.values()].filter((a) => a.items.length)
  if (!answers.length) list.append(text('li', 'Nothing in the other apps yet.', 'hint'))
  for (const { appName, frame, items } of answers) {
    list.append(text('li', appName, 'context-app'))
    for (const item of items) {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.className = 'context-item'
      b.append(text('span', item.title, 'context-item-title'))
      if (item.text) b.append(text('span', item.text, 'context-item-text'))
      b.addEventListener('click', () => {
        if (item.uri) routeOpen(item.uri, frame.active ?? undefined, frame)
        else if (item.url) window.open(item.url, '_blank', 'noopener')
      })
      li.append(b)
      list.append(li)
    }
  }
}

function flash(target: Frame) {
  target.el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  target.el.classList.remove('flash')
  void target.el.offsetWidth // restart the animation
  target.el.classList.add('flash')
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
      frame.handles = msg.handles ?? []
      frame.actions = msg.actions ?? []
      frame.ready = true
      rememberApp({ url: frame.url, name: msg.app.name, handles: frame.handles })
      // Frames of one app share storage, so the app's own "active" is
      // whatever any frame picked last. Which account *this* frame shows is
      // the shell's to remember.
      const want = frame.restore && accounts.find((a) => a.did === frame.restore)
      frame.restore = null
      if (want && want.did !== msg.active && msg.sessions.includes(want.did)) switchFrame(frame, want)
      if (frame.queuedOpen) {
        send(frame, frame.queuedOpen)
        frame.queuedOpen = null
      }
      queryContext()
      break
    }
    case 'state': {
      const switched = frame.active !== msg.active
      frame.sessions = msg.sessions
      frame.active = msg.active
      if (frame.pending === msg.active) frame.pending = null
      saveFrames()
      // Another account has other things to say about the focused item.
      if (switched && focus && focus.from !== frame) queryContext()
      break
    }
    case 'needs-sign-in':
      frame.pending = msg.did
      break
    case 'unread':
      frame.unread = new Map(msg.counts.filter((c) => c.count > 0).map((c) => [c.did, c.count]))
      renderAccounts()
      break
    case 'open':
      routeOpen(msg.uri, msg.did, frame)
      break
    case 'act':
      offerItem(msg.item, msg.did, frame)
      break
    case 'focus':
      setFocus(frame, msg.item)
      break
    case 'context':
      if (focus && msg.query === focus.query) {
        focus.answers.set(frame.origin, { appName: frame.appName, frame, items: msg.items.slice(0, 20) })
        renderContext()
      }
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

function knownApps(): KnownApp[] {
  try {
    const v = JSON.parse(localStorage.getItem('awp.apps') ?? '[]')
    return Array.isArray(v) ? v.filter((a) => a && typeof a.url === 'string' && Array.isArray(a.handles)) : []
  } catch {
    return []
  }
}

function rememberApp(app: KnownApp) {
  const rest = knownApps().filter((a) => a.url !== app.url)
  try {
    localStorage.setItem('awp.apps', JSON.stringify([app, ...rest].slice(0, 50)))
  } catch {}
}

/**
 * The demo app run as two apps: one shows posts, one shows profiles, so
 * links can travel between them.
 */
const DEFAULT_FRAMES: SavedFrame[] = [
  { url: `${APP_ORIGIN}/?name=Posts&handles=app.bsky.feed.post`, did: null },
  { url: `${APP_ORIGIN}/?name=Profiles&handles=app.bsky.actor.profile`, did: null },
]

/** Mocked partner apps with fake data, to show actions and "what links here". */
const MOCK_FRAMES: SavedFrame[] = [
  { url: `${MOCK_ORIGINS.skyreader}/`, did: null },
  { url: `${MOCK_ORIGINS.reams}/`, did: null },
  { url: `${MOCK_ORIGINS.roomy}/`, did: null },
]

const PRESETS: Record<string, SavedFrame[]> = { demo: DEFAULT_FRAMES, mocks: MOCK_FRAMES }

/** Replace the open frames with a preset. */
function openPreset(saved: SavedFrame[]) {
  for (const f of [...frames.values()]) closeFrame(f)
  for (const f of saved) openFrame(f.url, f.did)
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
  return DEFAULT_FRAMES
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
function badge(n: number, title: string) {
  const b = text('span', n > 99 ? '99+' : String(n), 'badge')
  b.title = title
  return b
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

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
  b.addEventListener('click', () => openPreset(PRESETS[b.dataset.preset!] ?? DEFAULT_FRAMES))
}
$<HTMLButtonElement>('#act-sheet .act-cancel').addEventListener('click', () => $<HTMLDialogElement>('#act-sheet').close())

await loadAccounts()
const preset = PRESETS[new URLSearchParams(location.search).get('preset') ?? '']
if (FEDCM_LOGIN) {
  // The browser opened login_url (with ?fedcm-login=1) because an app asked
  // for an account and the shell had none. Don't open frames in this popup.
  $<HTMLElement>('#fedcm-login').hidden = false
} else if (preset) {
  openPreset(preset)
  history.replaceState(null, '', location.pathname)
} else {
  for (const f of restoreFrames()) openFrame(f.url, f.did)
}
