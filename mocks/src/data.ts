// Fake data shared by the mock apps. Everything here is made up: the blogs
// live on .example domains and the authors' DIDs resolve to nothing. The
// apps share it so that a note in Reams and a message in Roomy can point at
// an article that Skyreader shows, the way real records would.

import type { AtUri, Did } from '../../protocol/messages.ts'

export interface Article {
  id: string
  site: string
  author: string
  date: string
  title: string
  url: string
  uri: AtUri
  body: string[]
}

const doc = (did: string, id: string) => `at://${did}/site.standard.document/${id}` as AtUri

export const ARTICLES: Article[] = [
  {
    id: 'lexicons-file-formats',
    site: 'Protocol Notes',
    author: 'June Park',
    date: 'Oct 24',
    title: 'Lexicons are the new file formats',
    url: 'https://protocolnotes.example/lexicons-file-formats',
    uri: doc('did:plc:protocolnotes', 'lexicons-file-formats'),
    body: [
      'For thirty years, a file format was a promise: write it here, open it there. The web broke that promise when our data moved into apps that never had to share.',
      'Lexicons bring it back. A record type with a public schema is a file format with an address. Any app that understands the schema can open what another app wrote.',
      'The interesting part is what happens next. Once two apps agree on a record, the user can move between them without exporting anything. The data was never inside the app to begin with.',
      'That changes what an app is. It stops being a silo and starts being a lens: one way of looking at records you already own.',
    ],
  },
  {
    id: 'gentle-crdts',
    site: 'Merge Conflicts Weekly',
    author: 'Sam Okafor',
    date: 'Oct 22',
    title: 'A gentle guide to CRDTs',
    url: 'https://mergeconflicts.example/gentle-crdts',
    uri: doc('did:plc:mergeconflicts', 'gentle-crdts'),
    body: [
      'A CRDT is a data structure that two people can edit at the same time, offline, and still end up agreeing. No server has to decide who was first.',
      'The trick is to make every change commute. If I insert a word and you delete a sentence, applying them in either order gives the same document.',
      'Local-first apps lean on this. Your edits land on your device instantly, and sync is something that happens later, in the background, without drama.',
      'The cost is bookkeeping: every character carries a little history. For notes and documents, that trade is almost always worth it.',
    ],
  },
  {
    id: 'calm-software',
    site: 'Slow Web',
    author: 'Rita Alvarez',
    date: 'Oct 20',
    title: 'Designing calm software',
    url: 'https://slowweb.example/calm-software',
    uri: doc('did:plc:slowweb', 'calm-software'),
    body: [
      'Calm software asks for attention only when it has earned it. It shows you what changed, then gets out of the way.',
      'Unread counts are the hardest test. A badge is a small request for your time. Ten badges in ten tabs is a noise floor you learn to ignore.',
      'One place that adds them up, per account, honestly, is calmer than ten places that each shout a little.',
    ],
  },
  {
    id: 'own-pds',
    site: 'Commons',
    author: 'Dee Mensah',
    date: 'Oct 18',
    title: 'Running a community on your own PDS',
    url: 'https://commons.example/own-pds',
    uri: doc('did:plc:commons', 'own-pds'),
    body: [
      'Our reading group moved its accounts to a PDS we run ourselves. Nobody noticed, which was the point.',
      'Members kept their handles, their follows and their posts. The apps they used kept working, because the apps never owned any of it.',
      'The hard part was not technical. It was deciding who holds the keys to the community account, and how we hand them over when someone steps back.',
    ],
  },
  {
    id: 'feed-reader-attention',
    site: 'Quiet Reader',
    author: 'Mo Lindqvist',
    date: 'Oct 15',
    title: 'What a feed reader taught me about attention',
    url: 'https://quietreader.example/attention',
    uri: doc('did:plc:quietreader', 'attention'),
    body: [
      'A feed reader has no algorithm. It shows you what you asked for, in the order it arrived, and then it runs out.',
      'Running out is a feature. It is the moment you get to stop.',
      'Sharing from a reader is different too. When a friend shares an article, it means they read it, not that it went viral.',
    ],
  },
]

export const articleByUri = (uri: string) => ARTICLES.find((a) => a.uri === uri)
export const articleByUrl = (url: string) => ARTICLES.find((a) => a.url === url)

// ---- Reams -------------------------------------------------------------------

export interface Note {
  id: string
  title: string
  /** Typed fields on the note (Reams calls these a Type's Record). */
  type?: { name: string; fields: [string, string][] }
  body: string
}

/** Notes every account starts with. Links point at the articles above. */
export function seedNotes(): Note[] {
  const [lexicons, crdts, calm] = ARTICLES
  return [
    {
      id: 'reading-list',
      title: 'Reading list',
      body: `Things to read this week:\n\n- [${lexicons.title}](${lexicons.url})\n- [${calm.title}](${calm.url})\n- Ask the book club about their PDS setup`,
    },
    {
      id: 'crdt-notes',
      title: 'CRDT notes',
      type: { name: 'Source', fields: [['author', crdts.author], ['url', crdts.url], ['status', 'reading']] },
      body: `> Your edits land on your device instantly, and sync is something that happens later.\n\nThis is the whole pitch for local-first. Compare with how sync works in Reams.\n\nSource: [${crdts.title}](${crdts.url})`,
    },
    {
      id: 'workspace-ideas',
      title: 'Ideas for my workspace',
      body: 'A notes pane next to everything else. Clip records into notes. See my notes about whatever I have open, without publishing them.',
    },
  ]
}

export const noteUri = (did: Did, id: string) => `at://${did}/demo.reams.note/${id}` as AtUri

// ---- Roomy -------------------------------------------------------------------

export interface Message {
  id: string
  author: string
  text: string
  /** A link card: something the message points at. */
  link?: { title: string; url?: string; uri?: AtUri }
}

export interface Channel {
  id: string
  name: string
  messages: Message[]
  /** Messages the account hasn't seen yet, counted from the end. */
  unread: number
}

export interface Space {
  id: string
  name: string
  channels: Channel[]
}

/** Spaces every account starts with. */
export function seedSpaces(did: Did): Space[] {
  const [lexicons, crdts, calm, pds, attention] = ARTICLES
  const card = (a: Article) => ({ title: a.title, url: a.url, uri: a.uri })
  return [
    {
      id: 'atmosphere-devs',
      name: 'Atmosphere devs',
      channels: [
        {
          id: 'general',
          name: 'general',
          unread: 1,
          messages: [
            { id: 'g1', author: 'rook.example', text: 'Has anyone tried the Spaces alpha yet?' },
            { id: 'g2', author: 'june.example', text: 'Wrote up why I think lexicons matter more than people realize', link: card(lexicons) },
            { id: 'g3', author: 'ada.example', text: 'Shipping a lexicon browser this weekend, feedback welcome' },
          ],
        },
        {
          id: 'reading',
          name: 'reading',
          unread: 2,
          messages: [
            { id: 'r1', author: 'sam.example', text: 'Best CRDT explainer I know', link: card(crdts) },
            {
              id: 'r2',
              author: 'ada.example',
              text: 'My notes on it, if useful',
              link: { title: 'CRDT notes', uri: noteUri(did, 'crdt-notes') },
            },
            { id: 'r3', author: 'rita.example', text: 'Related, on badges and attention', link: card(calm) },
          ],
        },
      ],
    },
    {
      id: 'book-club',
      name: 'Book club',
      channels: [
        {
          id: 'chat',
          name: 'chat',
          unread: 1,
          messages: [
            { id: 'b1', author: 'dee.example', text: 'Our PDS move, written up', link: card(pds) },
            { id: 'b2', author: 'mo.example', text: 'This one is short and good', link: card(attention) },
          ],
        },
      ],
    },
  ]
}

/** Messages that "arrive" while the demo runs, so badges move. */
export const INCOMING: { space: string; channel: string; message: Omit<Message, 'id'> }[] = [
  { space: 'atmosphere-devs', channel: 'general', message: { author: 'rook.example', text: 'Spaces alpha is live, docs are rough but it works' } },
  { space: 'book-club', channel: 'chat', message: { author: 'dee.example', text: 'Next meeting Thursday?' } },
  {
    space: 'atmosphere-devs',
    channel: 'reading',
    message: { author: 'june.example', text: 'Second part of the lexicons piece coming soon' },
  },
]
