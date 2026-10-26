// Mock Skyreader: a feed reader. Shows the fake articles, counts unread ones,
// and hands articles and highlights to other apps.

import type { AtUri, Did, Item } from '../../protocol/messages.ts'
import { ARTICLES, type Article } from './data.ts'
import {
  currentAccount,
  excerpt,
  focusOn,
  h,
  load,
  offer,
  pickAccountPrompt,
  rerender,
  save,
  toast,
  type MockApp,
} from './bridge.ts'

/** An article from a feed, or one saved from another app (which may have no record). */
type Entry = Omit<Article, 'uri'> & { uri?: AtUri }

interface Highlight {
  entry: string
  text: string
}

const readKey = (did: Did) => `sky.read.${did}`
const savedKey = (did: Did) => `sky.saved.${did}`
const highlightsKey = (did: Did) => `sky.highlights.${did}`
const sharedKey = (did: Did) => `sky.shared.${did}`

const entries = (did: Did): Entry[] => [...load<Entry[]>(savedKey(did), () => []), ...ARTICLES]
const readIds = (did: Did) => load<string[]>(readKey(did), () => [])
const highlights = (did: Did) => load<Highlight[]>(highlightsKey(did), () => [])

let selected: string | null = null

const asItem = (e: Entry): Item => ({ title: e.title, url: e.url, ...(e.uri ? { uri: e.uri } : {}) })

function select(did: Did, id: string, announce: boolean) {
  selected = id
  const read = readIds(did)
  if (!read.includes(id)) save(readKey(did), [...read, id])
  rerender()
  const e = entries(did).find((x) => x.id === id)
  if (announce && e) focusOn(asItem(e))
}

function findEntry(did: Did, item: Item) {
  return entries(did).find((e) => (item.uri && e.uri === item.uri) || (item.url && e.url === item.url))
}

export const skyreader: MockApp = {
  name: 'Skyreader',
  handles: ['site.standard.document'],
  actions: [{ id: 'read', label: 'Read in Skyreader', accepts: ['url', 'site.standard.document'] }],

  render(root, account) {
    root.className = 'app skyreader'
    if (!account) return root.replaceChildren(pickAccountPrompt('Skyreader'))
    const did = account.did
    const list = entries(did)
    const read = readIds(did)
    const current = list.find((e) => e.id === selected) ?? null

    const items = list.map((e) =>
      h(
        'li',
        null,
        h(
          'button.entry',
          { onclick: () => select(did, e.id, true), 'aria-current': e.id === selected ? 'true' : undefined },
          !read.includes(e.id) && h('span.dot', { 'aria-label': 'unread' }),
          h('span.entry-site', null, `${e.site} · ${e.date}`),
          h('span.entry-title', null, e.title),
        ),
      ),
    )
    const unread = list.filter((e) => !read.includes(e.id)).length

    root.replaceChildren(
      h(
        'header.bar',
        null,
        h('strong', null, 'Skyreader'),
        h('span.muted', null, `${unread} unread`),
        h('span.mock-tag', null, 'mock'),
      ),
      h(
        'div.split',
        null,
        h('ul.entries', null, ...items),
        current ? reader(did, current) : h('div.empty', null, h('p', null, 'Pick an article to read.')),
      ),
    )
  },

  open(uri) {
    const account = currentAccount()
    const e = account && entries(account.did).find((x) => x.uri === uri)
    if (!account) return
    if (e) select(account.did, e.id, false)
    else toast("That article isn't in your feeds")
  },

  perform(action, item) {
    const account = currentAccount()
    if (action !== 'read' || !account) return
    const did = account.did
    const existing = findEntry(did, item)
    if (existing) return select(did, existing.id, false)
    const entry: Entry = {
      id: `saved-${Date.now()}`,
      site: 'Saved',
      author: '',
      date: 'Today',
      title: item.title,
      url: item.url ?? '',
      ...(item.uri ? { uri: item.uri } : {}),
      body: [item.text || 'Saved from another app. In the real Skyreader, the full article would load here.'],
    }
    save(savedKey(did), [entry, ...load<Entry[]>(savedKey(did), () => [])])
    toast('Saved to read later')
    select(did, entry.id, false)
  },

  context(item, did) {
    const e = findEntry(did, item)
    if (!e) return []
    const own = highlights(did).filter((x) => x.entry === e.id)
    const shared = load<string[]>(sharedKey(did), () => []).includes(e.id)
    return [
      { ...asItem(e), text: `In your feed · ${e.site}${shared ? ' · on your linkblog' : ''}` },
      ...own.map((x) => ({ ...asItem(e), title: 'Your highlight', text: excerpt(x.text) })),
    ]
  },

  unread(did) {
    const read = readIds(did)
    return entries(did).filter((e) => !read.includes(e.id)).length
  },
}

function reader(did: Did, e: Entry) {
  const body = h('div.article-body', null, ...e.body.map((p) => h('p', null, p)))
  const highlightButton = h('button.secondary', { disabled: true }, 'Send highlight…')
  let quote = ''
  body.addEventListener('mouseup', () => {
    quote = String(document.getSelection() ?? '').trim()
    highlightButton.disabled = !quote
  })
  highlightButton.addEventListener('click', () => {
    if (!quote) return
    save(highlightsKey(did), [...highlights(did), { entry: e.id, text: quote }])
    offer({ ...asItem(e), title: `Highlight from “${e.title}”`, text: quote })
  })
  const shared = load<string[]>(sharedKey(did), () => [])
  const isShared = shared.includes(e.id)
  const own = highlights(did).filter((x) => x.entry === e.id)

  return h(
    'article.reader',
    null,
    h('p.byline', null, [e.site, e.author, e.date].filter(Boolean).join(' · ')),
    h('h1', null, e.title),
    h(
      'div.toolbar',
      null,
      h('button', { onclick: () => offer(asItem(e)) }, 'Send to…'),
      highlightButton,
      h(
        'button.secondary',
        {
          onclick: () => {
            save(sharedKey(did), isShared ? shared.filter((x) => x !== e.id) : [...shared, e.id])
            toast(isShared ? 'Removed from your linkblog' : 'Shared to your linkblog')
            rerender()
          },
        },
        isShared ? 'On your linkblog ✓' : 'Share to linkblog',
      ),
    ),
    body,
    own.length > 0 && h('h2', null, 'Your highlights'),
    own.length > 0 && h('ul.highlights', null, ...own.map((x) => h('li', null, x.text))),
    h('p.hint', null, 'Select text to send a highlight to another app.'),
  )
}
