// Mock Roomy: group chat in spaces and channels. Counts unread messages,
// shares items from other apps into a channel, and finds messages that link
// to whatever another app is showing.

import type { AtUri, Did, Item } from '../../protocol/messages.ts'
import { INCOMING, seedSpaces, type Channel, type Message, type Space } from './data.ts'
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

const spacesKey = (did: Did) => `roomy.spaces.${did}`
const spaces = (did: Did) => load<Space[]>(spacesKey(did), () => seedSpaces(did))

let open: { space: string; channel: string } | null = null
let highlighted: string | null = null

const messageUri = (did: Did, space: string, channel: string, id: string) =>
  `at://${did}/demo.roomy.message/${space}.${channel}.${id}` as AtUri

/** What a message hands to other apps: the thing it links to, else itself. */
function messageItem(did: Did, space: string, channel: Channel, m: Message): Item {
  if (m.link) return { title: m.link.title, ...(m.link.url ? { url: m.link.url } : {}), ...(m.link.uri ? { uri: m.link.uri } : {}) }
  return { title: `${m.author} in #${channel.name}`, uri: messageUri(did, space, channel.id, m.id), text: m.text }
}

function change(did: Did, fn: (all: Space[]) => void) {
  const all = spaces(did)
  fn(all)
  save(spacesKey(did), all)
}

function openChannel(did: Did, space: string, channel: string) {
  open = { space, channel }
  change(did, (all) => {
    const c = all.find((s) => s.id === space)?.channels.find((c) => c.id === channel)
    if (c) c.unread = 0
  })
  rerender()
}

export const roomy: MockApp = {
  name: 'Roomy',
  handles: ['demo.roomy.message'],
  actions: [{ id: 'share', label: 'Share in a Roomy channel', accepts: ['url', 'site.standard.document', 'demo.reams.note'] }],

  render(root, account) {
    root.className = 'app roomy'
    if (!account) return root.replaceChildren(pickAccountPrompt('Roomy'))
    const did = account.did
    const all = spaces(did)
    const space = all.find((s) => s.id === open?.space)
    const channel = space?.channels.find((c) => c.id === open?.channel)

    const rail = h(
      'nav.rail',
      null,
      ...all.map((s) =>
        h(
          'div.space',
          null,
          h('p.space-name', null, s.name),
          ...s.channels.map((c) =>
            h(
              'button.channel',
              { onclick: () => openChannel(did, s.id, c.id), 'aria-current': c === channel ? 'true' : undefined },
              `# ${c.name}`,
              c.unread > 0 && h('span.count', null, String(c.unread)),
            ),
          ),
        ),
      ),
    )

    root.replaceChildren(
      h(
        'header.bar',
        null,
        h('strong', null, 'Roomy'),
        h('span.muted', null, channel ? `${space!.name} › #${channel.name}` : 'Pick a channel'),
        h('span.mock-tag', null, 'mock'),
      ),
      h('div.split', null, rail, space && channel ? chat(did, account.handle, space, channel) : h('div.empty', null, h('p', null, 'Pick a channel.'))),
    )
    if (highlighted) document.getElementById(`m-${highlighted}`)?.scrollIntoView({ block: 'center' })
  },

  open(uri) {
    const account = currentAccount()
    if (!account) return
    const [space, channel, id] = (uri.split('/').pop() ?? '').split('.')
    const s = spaces(account.did).find((x) => x.id === space)
    if (!s?.channels.some((c) => c.id === channel && c.messages.some((m) => m.id === id))) {
      return toast("That message isn't in your spaces")
    }
    highlighted = id
    openChannel(account.did, space, channel)
  },

  perform(action, item) {
    const account = currentAccount()
    if (action !== 'share' || !account) return
    const did = account.did
    const target = open ?? { space: spaces(did)[0].id, channel: spaces(did)[0].channels[0].id }
    let name = ''
    change(did, (all) => {
      const c = all.find((s) => s.id === target.space)?.channels.find((c) => c.id === target.channel)
      if (!c) return
      name = c.name
      c.messages.push({
        id: `m${Date.now()}`,
        author: account.handle,
        text: item.text && !item.uri?.includes('/demo.reams.note/') ? `“${excerpt(item.text, 200)}”` : '',
        link: { title: item.title, ...(item.url ? { url: item.url } : {}), ...(item.uri ? { uri: item.uri } : {}) },
      })
    })
    open = target
    toast(`Shared to #${name}`)
    rerender()
  },

  context(item, did) {
    return spaces(did).flatMap((s) =>
      s.channels.flatMap((c) =>
        c.messages
          .filter((m) => mentions(m.text, item) || (!!m.link && ((!!item.url && m.link.url === item.url) || (!!item.uri && m.link.uri === item.uri))))
          .map((m) => ({
            title: `${m.author} in #${c.name}`,
            text: m.text || `Shared: ${m.link?.title ?? ''}`,
            uri: messageUri(did, s.id, c.id, m.id),
          })),
      ),
    )
  },

  unread: (did) => spaces(did).reduce((n, s) => n + s.channels.reduce((k, c) => k + c.unread, 0), 0),
}

function chat(did: Did, handle: string, space: Space, channel: Channel) {
  const list = h(
    'ol.messages',
    null,
    ...channel.messages.map((m) => {
      const item = messageItem(did, space.id, channel, m)
      return h(
        'li.message',
        {
          id: `m-${m.id}`,
          class: m.id === highlighted ? 'message highlighted' : undefined,
          onclick: () => focusOn({ ...item, title: m.link?.title ?? `${m.author} in #${channel.name}` }),
        },
        h('p.author', null, m.author === handle ? `${m.author} (you)` : m.author),
        m.text && h('p.text', null, m.text),
        m.link && linkCard(m.link),
        h('button.send', { title: 'Send to another app', onclick: (e: Event) => (e.stopPropagation(), offer(item)) }, 'Send to…'),
      )
    }),
  )
  const input = h('input', { placeholder: `Message #${channel.name}`, 'aria-label': 'Message' })
  const form = h('form.composer', null, input, h('button', null, 'Send'))
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (!input.value.trim()) return
    change(did, (all) => {
      all.find((s) => s.id === space.id)?.channels.find((c) => c.id === channel.id)?.messages.push({ id: `m${Date.now()}`, author: handle, text: input.value.trim() })
    })
    rerender()
  })
  return h('section.chat', null, list, form, h('p.hint', null, 'Click a message to see what links to it. Links open in the app that shows them.'))
}

function linkCard(link: NonNullable<Message['link']>) {
  const kind = link.uri?.includes('/demo.reams.note/') ? 'Reams note' : link.url ? new URL(link.url).host : 'Record'
  return h(
    'a.card',
    {
      href: link.url ?? '#',
      onclick: (e: Event) => {
        e.preventDefault()
        e.stopPropagation()
        // Records open in whichever app shows them; plain pages go to the share sheet.
        if (link.uri) openInShell(link.uri)
        else offer({ title: link.title, ...(link.url ? { url: link.url } : {}) })
      },
    },
    h('span.card-kind', null, kind),
    h('span.card-title', null, link.title),
  )
}

/** A few messages "arrive" while the demo runs, so the badges move. */
export function startIncoming() {
  let next = 0
  const tick = () => {
    const account = currentAccount()
    if (!account || next >= INCOMING.length) return
    const { space, channel, message } = INCOMING[next++]
    change(account.did, (all) => {
      const c = all.find((s) => s.id === space)?.channels.find((c) => c.id === channel)
      if (!c) return
      c.messages.push({ ...message, id: `in${Date.now()}` })
      if (!(open?.space === space && open.channel === channel)) c.unread++
    })
    rerender()
  }
  setTimeout(() => {
    tick()
    setInterval(tick, 45_000)
  }, 20_000)
}
