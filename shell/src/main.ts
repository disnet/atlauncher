// The atworkplace prototype: a thin sidebar of apps added by URL, and one
// profile (account) for the whole workspace.
//
// One app shows at a time; the others stay loaded so their badges keep
// coming. Picking a profile sends `switch` to every app that speaks
// atworkplace/1. Apps that don't still open as plain pages, and apps whose
// headers refuse framing get a link instead of a blank frame. The apps and
// the profile are saved with the shell session, next to its accounts.
//
// The earlier demo (two frames of one app, actions, "what links here") is
// at /demo/ (demo.ts).

import {
  PROTO,
  parseAppToShell,
  type AccountRef,
  type AtUri,
  type Did,
  type ShellToApp,
} from '../../protocol/messages.ts'
import { APP_ORIGIN, MOCK_ORIGINS } from '../../lib/config.ts'
import { appUrl, MAX_APPS, pickFrame, unreadByAccount, type SavedApp, type SavedWorkspace } from './workspace.ts'
import type { Probe } from '../probe.ts'

interface Account extends AccountRef {
  displayName?: string
  avatar?: string
}

/** How long an app gets to say `hello` before the shell treats it as a plain page. */
const HELLO_TIMEOUT_MS = 6000

interface View {
  app: SavedApp
  origin: string
  el: HTMLElement
  iframe: HTMLIFrameElement | null
  /** Said `hello`: speaks atworkplace/1. */
  ready: boolean
  /** No `hello` in time: a plain page, or one that refused to load. */
  plain: boolean
  checking: boolean
  sessions: Did[]
  active: Did | null
  pending: Did | null
  needsSignIn: boolean
  handles: string[]
  unread: Map<Did, number>
  helloTimer?: ReturnType<typeof setTimeout>
}

const $ = <T extends Element>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T
const params = new URLSearchParams(location.search)
const FEDCM_LOGIN = params.has('fedcm-login')

let accounts: Account[] = []
let workspace: SavedWorkspace = { apps: [], profile: null }
const views = new Map<string, View>()
let selected: string | null = null

// ---- server state ------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

let saving = Promise.resolve()
function saveWorkspace() {
  // Serialize saves so an older PUT can't land after a newer one.
  const body = JSON.stringify(workspace)
  saving = saving
    .then(() => api('/api/workspace', { method: 'PUT', headers: { 'content-type': 'application/json' }, body }))
    .then(
      () => {},
      (err) => console.warn("couldn't save the workspace", err),
    )
}

// ---- accounts and the profile -------------------------------------------------

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
  accounts = (
    await api<{ accounts: Account[] }>('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profile),
    })
  ).accounts
  ;(navigator as any).login?.setStatus?.('logged-in')
  // In the FedCM login popup, hand control back to the app's FedCM call.
  if (FEDCM_LOGIN) {
    ;(window as any).IdentityProvider?.close?.()
    return
  }
  // The first account becomes the profile; later ones wait to be picked.
  if (!currentProfile()) setProfile(profile.did)
  else renderProfile()
}

async function removeAccount(did: Did) {
  accounts = (await api<{ accounts: Account[] }>(`/api/accounts/${encodeURIComponent(did)}`, { method: 'DELETE' }))
    .accounts
  if (!accounts.length) (navigator as any).login?.setStatus?.('logged-out')
  for (const v of views.values()) send(v, { proto: PROTO, type: 'sign-out', did })
  if (workspace.profile === did) setProfile(accounts[0]?.did ?? null)
  else renderProfile()
}

const currentProfile = () => accounts.find((a) => a.did === workspace.profile) ?? null

function setProfile(did: Did | null) {
  workspace.profile = did
  saveWorkspace()
  const account = currentProfile()
  if (account) for (const v of views.values()) if (v.ready) switchView(v, account)
  renderProfile()
}

function switchView(v: View, a: Account) {
  if (v.active === a.did && !v.needsSignIn) return
  v.pending = a.did
  send(v, { proto: PROTO, type: 'switch', account: { did: a.did, handle: a.handle } })
  renderView(v)
}

function unreadTotals() {
  return unreadByAccount([...views.values()].map((v) => ({ origin: v.origin, counts: v.unread })))
}

function renderProfile() {
  const profile = currentProfile()
  const totals = unreadTotals()

  const btn = $<HTMLButtonElement>('#profile-btn')
  btn.replaceChildren(avatar(profile))
  btn.title = profile ? `Profile: @${profile.handle}` : 'Pick a profile'
  const otherUnread = [...totals].filter(([did]) => did !== profile?.did).reduce((n, [, c]) => n + c, 0)
  if (otherUnread) btn.append(badge(otherUnread, `${otherUnread} unread in your other profiles`))

  const ul = $<HTMLUListElement>('#profiles')
  ul.replaceChildren()
  if (!accounts.length) ul.append(text('li', 'No accounts yet. Add a handle below.', 'none'))
  for (const a of accounts) {
    const li = document.createElement('li')
    const pick = el('button', 'pick') as HTMLButtonElement
    pick.setAttribute('role', 'menuitemradio')
    pick.setAttribute('aria-checked', String(a.did === profile?.did))
    const who = el('div', 'who')
    const name = text('div', a.displayName || a.handle)
    const n = totals.get(a.did)
    if (n) name.append(' ', badge(n, `${n} unread across apps`))
    who.append(name, text('div', `@${a.handle}`, 'handle'))
    pick.append(avatar(a), who)
    pick.addEventListener('click', () => {
      setProfile(a.did)
      $<HTMLElement>('#profile-menu').hidePopover()
    })
    const rm = Object.assign(el('button', 'rm') as HTMLButtonElement, { textContent: '×', title: `Remove ${a.handle}` })
    rm.addEventListener('click', () => removeAccount(a.did))
    li.append(pick, rm)
    ul.append(li)
  }
  renderRail()
}

// ---- apps ----------------------------------------------------------------------

async function addApp(input: string) {
  const url = appUrl(input)
  if (!url || url.length > 2048) throw new Error('Enter a web address, like https://app.example')
  if (workspace.apps.length >= MAX_APPS) throw new Error(`The sidebar holds ${MAX_APPS} apps.`)
  const app: SavedApp = { id: crypto.randomUUID(), url, name: new URL(url).host }
  workspace.apps.push(app)
  saveWorkspace()
  const v = mountView(app, true)
  select(app.id)
  await check(v)
}

/**
 * Ask the shell's server whether the app's headers allow framing, and pick
 * up its title and icon. Only a clear "no" stops the frame from loading.
 */
async function check(v: View) {
  v.checking = true
  renderView(v)
  let probe: Probe | null = null
  try {
    probe = await api<Probe>(`/api/probe?url=${encodeURIComponent(v.app.url)}`)
  } catch (err) {
    console.warn('probe failed', err)
  }
  v.checking = false
  if (!views.has(v.app.id)) return // removed meanwhile
  // Follow a redirect to another origin (http → https, bare → www) before
  // framing, so the app's messages come from the origin the shell expects.
  if (probe && !v.iframe && new URL(probe.url).origin !== v.origin && appUrl(probe.url)) {
    v.app.url = probe.url
    v.origin = new URL(probe.url).origin
    for (const a of v.el.querySelectorAll<HTMLAnchorElement>('a.newtab')) a.href = probe.url
  }
  if (probe?.icon && !v.app.icon) v.app.icon = probe.icon
  if (probe?.title && (!v.app.name || v.app.name === new URL(v.app.url).host) && !v.ready) v.app.name = probe.title
  if (probe?.frameable === false) {
    v.app.blocked = probe.reason ?? 'The site refuses to be framed.'
    unframe(v)
  } else {
    delete v.app.blocked
    if (!v.iframe) frame(v)
  }
  saveWorkspace()
  renderView(v)
  renderRail()
}

function mountView(app: SavedApp, checking = false): View {
  const el = ($<HTMLTemplateElement>('#app-tpl').content.firstElementChild!.cloneNode(true)) as HTMLElement
  const v: View = {
    app,
    origin: new URL(app.url).origin,
    el,
    iframe: null,
    ready: false,
    plain: false,
    checking,
    sessions: [],
    active: null,
    pending: null,
    needsSignIn: false,
    handles: [],
    unread: new Map(),
  }
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a.newtab')) a.href = app.url
  $<HTMLButtonElement>('.reload', el).addEventListener('click', () => {
    if (!v.iframe) return void check(v)
    frame(v)
    renderView(v)
    renderProfile()
  })
  $<HTMLButtonElement>('.remove', el).addEventListener('click', () => removeApp(v))
  $<HTMLButtonElement>('.recheck', el).addEventListener('click', () => check(v))
  views.set(app.id, v)
  $('#stage').append(el)
  // A blocked app stays a link until the user asks to check again. Anything
  // else frames now; a new app waits for its check first.
  if (!app.blocked && !checking) frame(v)
  renderView(v)
  return v
}

/** (Re)load the app's iframe. */
function frame(v: View) {
  unframe(v)
  const iframe = document.createElement('iframe')
  iframe.allow = 'identity-credentials-get'
  iframe.title = v.app.name ?? v.origin
  iframe.src = v.app.url
  v.iframe = iframe
  $('.blocked', v.el).before(iframe)
  // `load` fires for a page and for the browser's own "refused to connect"
  // page alike, so the only sign the app speaks the protocol is `hello`.
  v.helloTimer = setTimeout(() => {
    if (v.ready) return
    v.plain = true
    renderView(v)
    renderRail()
  }, HELLO_TIMEOUT_MS)
}

function unframe(v: View) {
  clearTimeout(v.helloTimer)
  v.iframe?.remove()
  v.iframe = null
  Object.assign(v, { ready: false, plain: false, sessions: [], active: null, pending: null, needsSignIn: false })
  v.unread = new Map()
}

function removeApp(v: View) {
  unframe(v)
  v.el.remove()
  views.delete(v.app.id)
  workspace.apps = workspace.apps.filter((a) => a.id !== v.app.id)
  saveWorkspace()
  if (selected === v.app.id) select(workspace.apps[0]?.id ?? null)
  renderProfile()
}

function select(id: string | null) {
  selected = id
  for (const v of views.values()) v.el.hidden = v.app.id !== id
  $<HTMLElement>('#empty').hidden = id !== null
  renderRail()
}

function renderRail() {
  const profile = currentProfile()
  const ul = $<HTMLUListElement>('#apps')
  ul.replaceChildren()
  for (const app of workspace.apps) {
    const v = views.get(app.id)
    if (!v) continue
    const li = document.createElement('li')
    const b = el('button', 'rail-app') as HTMLButtonElement
    b.classList.toggle('selected', app.id === selected)
    b.classList.toggle('trouble', Boolean(app.blocked))
    b.title = `${app.name ?? v.origin}${app.blocked ? " (won't open inside atworkplace)" : ''}`
    b.setAttribute('aria-label', b.title)
    b.append(appIcon(app))
    const shown = v.active ?? profile?.did
    const n = shown ? v.unread.get(shown) : 0
    if (n) b.append(badge(n, `${n} unread`))
    b.addEventListener('click', () => select(app.id))
    li.append(b)
    ul.append(li)
  }
}

function renderView(v: View) {
  $<HTMLElement>('.app-name', v.el).textContent = v.app.name ?? v.origin
  const status = $<HTMLElement>('.status', v.el)
  const [msg, tone] = viewStatus(v)
  status.textContent = msg
  status.className = `status ${tone}`
  status.title = msg

  const blocked = $<HTMLElement>('.blocked', v.el)
  blocked.hidden = !v.app.blocked
  if (v.app.blocked) {
    $<HTMLElement>('h2', blocked).textContent = `${v.app.name ?? v.origin} won't open inside atworkplace`
    $<HTMLElement>('.why', blocked).textContent = v.app.blocked
  }
}

function viewStatus(v: View): [string, '' | 'ok' | 'warn'] {
  const profile = currentProfile()
  const handle = (did: Did | null) => accounts.find((a) => a.did === did)?.handle ?? did
  if (v.checking) return ['checking…', '']
  if (v.app.blocked) return ['refuses to be framed', 'warn']
  if (v.plain)
    return [
      "doesn't speak atworkplace/1, so it won't follow your profile. If it stays blank, it may refuse to be framed: open it in a new tab.",
      'warn',
    ]
  if (!v.ready) return ['loading…', '']
  if (v.needsSignIn && v.pending) return [`sign in as @${handle(v.pending)} in the app`, 'warn']
  if (v.pending && v.pending !== v.active) return [`switching to @${handle(v.pending)}…`, '']
  if (v.active && profile && v.active !== profile.did)
    return [`as @${handle(v.active)}, not your profile @${profile.handle}`, 'warn']
  if (v.active) return [`as @${handle(v.active)}`, 'ok']
  return ['signed out', '']
}

function send(v: View, msg: ShellToApp) {
  // Always target the app's own origin so a navigated-away frame gets nothing.
  if (v.ready) v.iframe?.contentWindow?.postMessage(msg, v.origin)
}

function notice(v: View, message: string) {
  const n = $<HTMLElement>('.notice', v.el)
  n.textContent = message
  n.hidden = false
  setTimeout(() => (n.hidden = true), 6000)
}

/** Show an `at://` link in an app that handles its collection. */
function routeOpen(uri: AtUri, did: Did | undefined, from: View) {
  const target = pickFrame(
    [...views.values()].filter((v) => v.ready).map((v) => ({ id: v.app.id, handles: v.handles, active: v.active, v })),
    uri,
    did ?? workspace.profile ?? undefined,
  )?.v
  if (!target) {
    notice(from, "None of your apps opens that kind of record. Add one that does, and it'll open there.")
    return
  }
  const account = accounts.find((a) => a.did === (did ?? workspace.profile))
  if (account && target.active !== account.did) target.pending = account.did
  send(target, {
    proto: PROTO,
    type: 'open',
    uri,
    ...(account ? { account: { did: account.did, handle: account.handle } } : {}),
  })
  select(target.app.id)
  renderView(target)
}

window.addEventListener('message', (event) => {
  const v = [...views.values()].find((x) => x.iframe && x.iframe.contentWindow === event.source)
  if (!v || event.origin !== v.origin) return
  const msg = parseAppToShell(event.data)
  if (!msg) return
  switch (msg.type) {
    case 'hello': {
      clearTimeout(v.helloTimer)
      v.ready = true
      v.plain = false
      v.sessions = msg.sessions
      v.active = msg.active
      v.handles = msg.handles ?? []
      if (v.app.name !== msg.app.name) {
        v.app.name = msg.app.name
        saveWorkspace()
      }
      // The workspace's profile wins. If the app has no session for it, the
      // `switch` makes the app show its own "Continue as" prompt.
      const profile = currentProfile()
      if (profile && msg.active !== profile.did) switchView(v, profile)
      break
    }
    case 'state':
      v.sessions = msg.sessions
      v.active = msg.active
      if (v.pending === msg.active) {
        v.pending = null
        v.needsSignIn = false
      }
      break
    case 'needs-sign-in':
      v.pending = msg.did
      v.needsSignIn = true
      break
    case 'unread':
      v.unread = new Map(msg.counts.filter((c) => c.count > 0).map((c) => [c.did, c.count]))
      renderProfile()
      break
    case 'open':
      routeOpen(msg.uri, msg.did, v)
      break
    case 'act':
      notice(v, '"Send to…" isn\'t in the prototype yet. The demo at /demo/ has it.')
      break
    case 'focus':
    case 'context':
      // "What links here" is only in the demo so far.
      break
  }
  renderView(v)
  renderRail()
})

// ---- helpers & boot ---------------------------------------------------------------

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
function avatar(a: Account | null) {
  if (a?.avatar) return Object.assign(document.createElement('img'), { src: a.avatar, alt: '' })
  return text('span', (a?.displayName || a?.handle || '?').slice(0, 1).toUpperCase(), 'avatar')
}
function appIcon(app: SavedApp) {
  const letter = text('span', (app.name ?? new URL(app.url).host).replace(/^www\./, '').slice(0, 1), 'letter')
  if (!app.icon) return letter
  const img = Object.assign(document.createElement('img'), { src: app.icon, alt: '' })
  img.addEventListener('error', () => img.replaceWith(letter))
  return img
}

/** Apps to try from the empty state: ones that speak the protocol, and two that don't. */
const SUGGESTIONS: { label: string; url: string; note?: string }[] = [
  { label: 'Demo app', url: `${APP_ORIGIN}/` },
  { label: 'Skyreader', url: `${MOCK_ORIGINS.skyreader}/`, note: 'mock' },
  { label: 'Reams', url: `${MOCK_ORIGINS.reams}/`, note: 'mock' },
  { label: 'Roomy', url: `${MOCK_ORIGINS.roomy}/`, note: 'mock' },
  { label: 'example.com', url: 'https://example.com/', note: 'plain page' },
  { label: 'github.com', url: 'https://github.com/', note: 'refuses framing' },
]

function renderSuggestions() {
  const ul = $<HTMLUListElement>('#suggestions')
  for (const s of SUGGESTIONS) {
    const b = el('button', 'secondary') as HTMLButtonElement
    b.append(s.label)
    if (s.note) b.append(text('span', s.note, 'note'))
    b.addEventListener('click', () => addApp(s.url).catch(alertError))
    const li = document.createElement('li')
    li.append(b)
    ul.append(li)
  }
}

function alertError(err: unknown) {
  alert(err instanceof Error ? err.message : String(err))
}

for (const form of document.querySelectorAll<HTMLFormElement>('form[data-add-app]')) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = form.elements.namedItem('url') as HTMLInputElement
    try {
      $<HTMLDialogElement>('#add-app').close()
      await addApp(input.value)
      input.value = ''
    } catch (err) {
      alertError(err)
    }
  })
}
for (const form of document.querySelectorAll<HTMLFormElement>('form[data-add-account]')) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = form.elements.namedItem('handle') as HTMLInputElement
    try {
      await addAccount(input.value)
      input.value = ''
    } catch (err) {
      alertError(err)
    }
  })
}
$<HTMLButtonElement>('#add-app-btn').addEventListener('click', () => {
  $<HTMLDialogElement>('#add-app').showModal()
})
$<HTMLButtonElement>('#add-app [data-close]').addEventListener('click', () => $<HTMLDialogElement>('#add-app').close())

if (params.has('preset')) {
  // Presets belong to the demo, which used to live here.
  location.replace(`/demo/${location.search}`)
} else if (FEDCM_LOGIN) {
  // The browser opened login_url because an app asked for an account and
  // the shell had none. Don't open apps in this popup.
  $<HTMLElement>('#fedcm-login').hidden = false
  document.body.classList.add('popup')
} else {
  renderSuggestions()
  const [acc, ws] = await Promise.all([
    api<{ accounts: Account[] }>('/api/accounts'),
    api<SavedWorkspace>('/api/workspace'),
  ])
  accounts = acc.accounts
  workspace = ws
  for (const app of workspace.apps) mountView(app)
  select(workspace.apps[0]?.id ?? null)
  renderProfile()
}
