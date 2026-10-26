// What every mock app shares: speaking atworkplace/1 to the shell, fake
// sessions, local storage, and a few DOM helpers.
//
// Sessions are fake. A real app would sign in to the account's PDS with
// OAuth; a mock just believes the shell, so `switch` always succeeds.

import { SHELL_ORIGIN } from '../../lib/config.ts'
import {
  PROTO,
  parseShellToApp,
  type AccountRef,
  type ActionDecl,
  type AppToShell,
  type AtUri,
  type Did,
  type Item,
} from '../../protocol/messages.ts'

/** What a mock app is, and what it does when the shell asks. */
export interface MockApp {
  name: string
  handles: string[]
  actions: ActionDecl[]
  /** Draw the app for `account` (null: none picked yet) into `root`. */
  render(root: HTMLElement, account: AccountRef | null): void
  open(uri: AtUri): void
  perform(action: string, item: Item): void
  /** Items this app has about `item`, for the account `did`. */
  context(item: Item, did: Did): Item[]
  /** Unread count for an account. */
  unread(did: Did): number
}

const embedded = window.top !== window

// ---- storage -------------------------------------------------------------------

export function load<T>(key: string, fallback: () => T): T {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return JSON.parse(v) as T
  } catch {}
  return fallback()
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

// ---- sessions --------------------------------------------------------------------

let sessions: AccountRef[] = load('mock.sessions', () => [])
let active: Did | null = load('mock.active', () => null)

export const currentAccount = () => sessions.find((s) => s.did === active) ?? null

// ---- talking to the shell ----------------------------------------------------------

function toShell(msg: AppToShell) {
  if (embedded) window.parent.postMessage(msg, SHELL_ORIGIN)
}

export const openInShell = (uri: AtUri) => toShell({ proto: PROTO, type: 'open', uri, ...(active ? { did: active } : {}) })
export const offer = (item: Item) => toShell({ proto: PROTO, type: 'act', item, ...(active ? { did: active } : {}) })
export const focusOn = (item: Item | null) => toShell({ proto: PROTO, type: 'focus', item })

let app: MockApp
let root: HTMLElement
let lastUnread = ''

/** Tell the shell the unread counts, if they changed. Call after any change. */
export function reportUnread() {
  const counts = sessions.map((s) => ({ did: s.did, count: app.unread(s.did) })).filter((c) => c.count > 0)
  const key = JSON.stringify(counts)
  if (key === lastUnread) return
  lastUnread = key
  toShell({ proto: PROTO, type: 'unread', counts })
}

/** Redraw the app for the current account. */
export function rerender() {
  app.render(root, currentAccount())
  reportUnread()
}

function useAccount(account: AccountRef) {
  sessions = [...sessions.filter((s) => s.did !== account.did), account]
  active = account.did
  save('mock.sessions', sessions)
  save('mock.active', active)
  toShell({ proto: PROTO, type: 'state', sessions: sessions.map((s) => s.did), active })
  focusOn(null)
  rerender()
}

export function start(mockApp: MockApp, mountPoint: HTMLElement) {
  app = mockApp
  root = mountPoint
  document.title = `${app.name} (mock)`

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== SHELL_ORIGIN) return
    const msg = parseShellToApp(event.data)
    if (!msg) return
    switch (msg.type) {
      case 'switch':
        useAccount(msg.account)
        break
      case 'sign-out':
        sessions = sessions.filter((s) => s.did !== msg.did)
        if (active === msg.did) active = null
        save('mock.sessions', sessions)
        save('mock.active', active)
        toShell({ proto: PROTO, type: 'state', sessions: sessions.map((s) => s.did), active })
        rerender()
        break
      case 'open':
        if (msg.account && msg.account.did !== active) useAccount(msg.account)
        app.open(msg.uri)
        break
      case 'perform':
        if (msg.account && msg.account.did !== active) useAccount(msg.account)
        if (currentAccount()) app.perform(msg.action, msg.item)
        break
      case 'context-query': {
        const did = msg.did ?? active
        const items = did && sessions.some((s) => s.did === did) ? app.context(msg.item, did) : []
        toShell({ proto: PROTO, type: 'context', query: msg.query, items })
        break
      }
    }
  })

  toShell({
    proto: PROTO,
    type: 'hello',
    app: { name: app.name },
    sessions: sessions.map((s) => s.did),
    active,
    handles: app.handles,
    actions: app.actions,
  })
  rerender()
}

// ---- DOM helpers ---------------------------------------------------------------------

type Child = Node | string | null | undefined | false

/** Make an element: h('div.card', { onclick }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  props: Partial<Record<string, unknown>> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split('.')
  const el = document.createElement(tag as K)
  if (classes.length) el.className = classes.join(' ')
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c) el.append(c)
  return el
}

/** The empty state before the shell names an account. */
export function pickAccountPrompt(appName: string) {
  return h(
    'div.empty',
    null,
    h('p.empty-title', null, appName),
    h(
      'p',
      null,
      embedded
        ? 'Pick an account in the atworkplace sidebar to start.'
        : 'This is a mock app for the atworkplace demo. Open it from the workspace.',
    ),
    h('p.mock-note', null, 'Mock app with fake data. Not the real thing.'),
  )
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(text: string) {
  let el = document.querySelector<HTMLElement>('.toast')
  if (!el) {
    el = h('div.toast', { role: 'status' })
    document.body.append(el)
  }
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el!.classList.remove('show'), 2500)
}

/** Short excerpt, for context items. */
export const excerpt = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Does `text` mention the item's record or page? */
export function mentions(text: string, item: Item) {
  return (!!item.url && text.includes(item.url)) || (!!item.uri && text.includes(item.uri))
}
