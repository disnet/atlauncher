// Mock Reams: a Markdown notes app. Takes notes about items from other apps
// and answers "what links here" from notes that never leave the device.

import type { Did, Item } from '../../protocol/messages.ts'
import { noteUri, seedNotes, type Note } from './data.ts'
import {
  currentAccount,
  excerpt,
  focusOn,
  h,
  load,
  mentions,
  offer,
  openInShell,
  pickAccountPrompt,
  rerender,
  save,
  toast,
  type MockApp,
} from './bridge.ts'

const notesKey = (did: Did) => `reams.notes.${did}`
const notes = (did: Did) => load<Note[]>(notesKey(did), seedNotes)

let selected: string | null = null
let editing = false

const firstUrl = (s: string) => s.match(/https?:\/\/[^\s)]+/)?.[0]
const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[>-]\s*/gm, '').replace(/\s+/g, ' ')
const noteText = (n: Note) => [n.body, ...(n.type?.fields.map(([, v]) => v) ?? [])].join('\n')

function noteItem(did: Did, n: Note): Item {
  const url = firstUrl(noteText(n))
  return { title: n.title, uri: noteUri(did, n.id), ...(url ? { url } : {}), text: excerpt(plain(n.body)) }
}

function select(did: Did, id: string, announce: boolean) {
  selected = id
  editing = false
  rerender()
  const n = notes(did).find((x) => x.id === id)
  if (announce && n) focusOn(noteItem(did, n))
}

function update(did: Did, note: Note) {
  save(notesKey(did), notes(did).map((n) => (n.id === note.id ? note : n)))
}

export const reams: MockApp = {
  name: 'Reams',
  handles: ['demo.reams.note'],
  actions: [{ id: 'note', label: 'Take a note in Reams', accepts: ['url', 'site.standard.document', 'demo.roomy.message'] }],

  render(root, account) {
    root.className = 'app reams'
    if (!account) return root.replaceChildren(pickAccountPrompt('Reams'))
    const did = account.did
    const all = notes(did)
    const current = all.find((n) => n.id === selected) ?? null

    root.replaceChildren(
      h(
        'header.bar',
        null,
        h('strong', null, 'Reams'),
        h('span.muted', null, `@${account.handle}'s vault`),
        h('span.mock-tag', null, 'mock'),
      ),
      h(
        'div.split',
        null,
        h(
          'nav.files',
          null,
          h(
            'button.new',
            {
              onclick: () => {
                const n: Note = { id: `n${Date.now()}`, title: 'Untitled', body: '' }
                save(notesKey(did), [n, ...all])
                selected = n.id
                editing = true
                rerender()
              },
            },
            '+ New note',
          ),
          h(
            'ul',
            null,
            ...all.map((n) =>
              h(
                'li',
                null,
                h(
                  'button.file',
                  { onclick: () => select(did, n.id, true), 'aria-current': n.id === selected ? 'true' : undefined },
                  n.title,
                ),
              ),
            ),
          ),
        ),
        current ? editor(did, current) : h('div.empty', null, h('p', null, 'Pick a note.')),
      ),
    )
  },

  open(uri) {
    const account = currentAccount()
    if (!account) return
    const id = uri.split('/').pop()!
    if (notes(account.did).some((n) => n.id === id)) select(account.did, id, false)
    else toast("That note isn't in this vault")
  },

  perform(action, item) {
    const account = currentAccount()
    if (action !== 'note' || !account) return
    const did = account.did
    const fields: [string, string][] = []
    if (item.url) fields.push(['url', item.url])
    if (item.uri) fields.push(['record', item.uri])
    fields.push(['captured', new Date().toLocaleDateString()])
    const quote = item.text ? `${item.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` : ''
    const source = item.url ? `Source: [${item.title}](${item.url})` : item.uri ? `Source: ${item.uri}` : ''
    const note: Note = {
      id: `n${Date.now()}`,
      title: excerpt(item.title, 60),
      type: { name: 'Clipping', fields },
      body: `${quote}${source}`,
    }
    save(notesKey(did), [note, ...notes(did)])
    toast('Note created')
    select(did, note.id, false)
  },

  context(item, did) {
    return notes(did)
      .filter((n) => mentions(noteText(n), item))
      .map((n) => ({ ...noteItem(did, n), text: `Private note · ${excerpt(plain(n.body), 90)}` }))
  },

  unread: () => 0,
}

function editor(did: Did, n: Note) {
  const title = h('input.title', { value: n.title, 'aria-label': 'Title' })
  title.addEventListener('change', () => {
    update(did, { ...n, title: title.value || 'Untitled' })
    rerender()
  })
  const fields =
    n.type &&
    h(
      'dl.fields',
      null,
      h('dt', null, 'Type'),
      h('dd', null, h('span.type', null, n.type.name)),
      ...n.type.fields.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
    )

  let body: HTMLElement
  if (editing) {
    const ta = h('textarea.source', { 'aria-label': 'Note' })
    ta.value = n.body
    ta.addEventListener('blur', () => {
      update(did, { ...n, body: ta.value })
      editing = false
      rerender()
    })
    queueMicrotask(() => ta.focus())
    body = ta
  } else {
    body = h('div.preview', { title: 'Double-click to edit', ondblclick: () => ((editing = true), rerender()) }, ...markdown(n.body))
  }

  return h(
    'section.editor',
    null,
    title,
    fields,
    body,
    h(
      'div.toolbar',
      null,
      h('button', { onclick: () => offer(noteItem(did, n)) }, 'Send to…'),
      !editing && h('button.secondary', { onclick: () => ((editing = true), rerender()) }, 'Edit'),
    ),
  )
}

/** Just enough Markdown for the demo: quotes, lists, links and at:// URIs. */
function markdown(src: string): Node[] {
  return src.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n')
    if (lines.every((l) => l.startsWith('- '))) return h('ul', null, ...lines.map((l) => h('li', null, ...inline(l.slice(2)))))
    if (lines.every((l) => l.startsWith('>'))) return h('blockquote', null, ...inline(lines.map((l) => l.replace(/^>\s?/, '')).join(' ')))
    return h('p', null, ...inline(lines.join(' ')))
  })
}

function inline(text: string): Node[] {
  const out: Node[] = []
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(at:\/\/[^\s)]+)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    out.push(document.createTextNode(text.slice(last, m.index)))
    if (m[3]) {
      const uri = m[3] as `at://${string}`
      out.push(h('a.at', { href: '#', title: 'Open in the app that shows it', onclick: (e: Event) => (e.preventDefault(), openInShell(uri)) }, uri))
    } else {
      const [, label, url] = m
      // Web links offer the page to other apps (read it, share it) instead of leaving.
      out.push(h('a', { href: url, title: 'Send to another app', onclick: (e: Event) => (e.preventDefault(), offer({ title: label, url })) }, label))
    }
    last = m.index! + m[0].length
  }
  out.push(document.createTextNode(text.slice(last)))
  return out
}
