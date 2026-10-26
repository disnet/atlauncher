import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTO,
  acceptsItem,
  collectionOf,
  handlesCollection,
  parseAppToShell,
  parseShellToApp,
} from '../protocol/messages.ts'
import { actionsFor, pickFrame, unreadByAccount } from '../shell/src/workspace.ts'

const alice = 'did:plc:alice' as const
const bob = 'did:plc:bob' as const
const post = `at://${alice}/app.bsky.feed.post/3kabc` as const
const profile = `at://${bob}/app.bsky.actor.profile/self` as const

test('unread and open messages', () => {
  assert.ok(parseAppToShell({ proto: PROTO, type: 'unread', counts: [{ did: alice, count: 3 }] }))
  assert.ok(parseAppToShell({ proto: PROTO, type: 'unread', counts: [] }))
  assert.equal(parseAppToShell({ proto: PROTO, type: 'unread', counts: [{ did: alice, count: -1 }] }), null)
  assert.equal(parseAppToShell({ proto: PROTO, type: 'unread', counts: [{ did: alice, count: 1.5 }] }), null)

  assert.ok(parseAppToShell({ proto: PROTO, type: 'open', uri: post, did: alice }))
  assert.ok(parseAppToShell({ proto: PROTO, type: 'open', uri: `at://${alice}` }))
  assert.equal(parseAppToShell({ proto: PROTO, type: 'open', uri: 'https://bsky.app/profile/x' }), null)
  assert.equal(parseAppToShell({ proto: PROTO, type: 'open', uri: 'at://x/y/z/extra' }), null)

  assert.ok(parseShellToApp({ proto: PROTO, type: 'open', uri: post }))
  assert.ok(parseShellToApp({ proto: PROTO, type: 'open', uri: post, account: { did: alice, handle: 'alice.test' } }))
  assert.equal(parseShellToApp({ proto: PROTO, type: 'open', uri: post, account: { did: 'nope', handle: 'a' } }), null)
})

test('hello may list handled collections', () => {
  const hello = { proto: PROTO, type: 'hello', app: { name: 'x' }, sessions: [], active: null }
  assert.ok(parseAppToShell(hello)) // older apps send none
  assert.ok(parseAppToShell({ ...hello, handles: ['app.bsky.feed.post', 'pub.leaflet.*'] }))
  assert.equal(parseAppToShell({ ...hello, handles: ['not an nsid'] }), null)
  assert.equal(parseAppToShell({ ...hello, handles: 'app.bsky.feed.post' }), null)
})

test('collections and patterns', () => {
  assert.equal(collectionOf(post), 'app.bsky.feed.post')
  assert.equal(collectionOf(`at://${alice}`), null)
  assert.ok(handlesCollection(['app.bsky.feed.post'], 'app.bsky.feed.post'))
  assert.ok(handlesCollection(['app.bsky.feed.*'], 'app.bsky.feed.like'))
  assert.ok(!handlesCollection(['app.bsky.feed.*'], 'app.bsky.feedx.like'))
  assert.ok(!handlesCollection(['app.bsky.feed.post'], 'app.bsky.feed.like'))
})

test('pickFrame routes by collection, preferring the same account', () => {
  const frames = [
    { id: 'posts-bob', handles: ['app.bsky.feed.post'], active: bob },
    { id: 'posts-alice', handles: ['app.bsky.feed.post'], active: alice },
    { id: 'profiles', handles: ['app.bsky.actor.profile'], active: null },
  ]
  assert.equal(pickFrame(frames, post, alice)?.id, 'posts-alice')
  assert.equal(pickFrame(frames, post)?.id, 'posts-bob')
  assert.equal(pickFrame(frames, profile, alice)?.id, 'profiles')
  assert.equal(pickFrame(frames, `at://${alice}/pub.leaflet.document/1`), null)
  assert.equal(pickFrame(frames, `at://${alice}`), null)
})

test('unreadByAccount counts each app origin once', () => {
  const a = new Map([[alice, 2]] as const)
  const totals = unreadByAccount([
    { origin: 'https://posts.example', counts: a },
    { origin: 'https://posts.example', counts: a }, // second frame, same app
    { origin: 'https://other.example', counts: new Map<typeof alice | typeof bob, number>([[alice, 1], [bob, 4]]) },
  ])
  assert.equal(totals.get(alice), 3)
  assert.equal(totals.get(bob), 4)
})

const article = { title: 'Lexicons', url: 'https://example.com/a', uri: `at://${alice}/site.standard.document/a` as const }

test('act, focus and context messages', () => {
  assert.ok(parseAppToShell({ proto: PROTO, type: 'act', item: article, did: alice }))
  assert.ok(parseAppToShell({ proto: PROTO, type: 'act', item: { title: 'Just a page', url: 'http://example.com' } }))
  assert.equal(parseAppToShell({ proto: PROTO, type: 'act', item: { url: 'https://example.com' } }), null) // no title
  assert.equal(parseAppToShell({ proto: PROTO, type: 'act', item: { title: 'x', url: 'javascript:alert(1)' } }), null)
  assert.equal(parseAppToShell({ proto: PROTO, type: 'act', item: { title: 'x', uri: 'https://nope' } }), null)

  assert.ok(parseAppToShell({ proto: PROTO, type: 'focus', item: article }))
  assert.ok(parseAppToShell({ proto: PROTO, type: 'focus', item: null }))
  assert.ok(parseAppToShell({ proto: PROTO, type: 'context', query: 'q1', items: [article] }))
  assert.equal(parseAppToShell({ proto: PROTO, type: 'context', items: [article] }), null) // no query

  assert.ok(parseShellToApp({ proto: PROTO, type: 'perform', action: 'note', item: article }))
  assert.ok(parseShellToApp({ proto: PROTO, type: 'perform', action: 'note', item: article, account: { did: alice, handle: 'a' } }))
  assert.equal(parseShellToApp({ proto: PROTO, type: 'perform', item: article }), null) // no action
  assert.ok(parseShellToApp({ proto: PROTO, type: 'context-query', query: 'q1', item: article, did: alice }))
  assert.equal(parseShellToApp({ proto: PROTO, type: 'context-query', query: 'q1', item: article, did: 'x' }), null)
})

test('hello may list actions', () => {
  const hello = { proto: PROTO, type: 'hello', app: { name: 'x' }, sessions: [], active: null }
  assert.ok(parseAppToShell({ ...hello, actions: [{ id: 'note', label: 'Take a note', accepts: ['url', 'site.standard.*'] }] }))
  assert.equal(parseAppToShell({ ...hello, actions: [{ id: 'note', label: 'Take a note', accepts: ['not an nsid'] }] }), null)
  assert.equal(parseAppToShell({ ...hello, actions: [{ id: 'note', accepts: ['url'] }] }), null)
})

test('which actions accept an item', () => {
  assert.ok(acceptsItem(['url'], article))
  assert.ok(acceptsItem(['site.standard.document'], { title: 'x', uri: article.uri }))
  assert.ok(!acceptsItem(['url'], { title: 'x', uri: article.uri }))
  assert.ok(!acceptsItem(['app.bsky.feed.post'], article))

  const note = { id: 'note', label: 'Take a note', accepts: ['url'] }
  const share = { id: 'share', label: 'Share', accepts: ['app.bsky.feed.post'] }
  const frames = [
    { id: '1', origin: 'https://reader.test', active: alice, actions: [note] },
    { id: '2', origin: 'https://notes.test', active: alice, actions: [note] },
    { id: '3', origin: 'https://notes.test', active: bob, actions: [note] }, // same app again
    { id: '4', origin: 'https://chat.test', active: null, actions: [share] },
  ]
  const offered = actionsFor(frames, article, 'https://reader.test')
  assert.deepEqual(offered.map((o) => o.frame.id), ['2']) // not the offering app, one per app, only accepting actions
  assert.deepEqual(actionsFor(frames, { title: 'p', uri: post }, 'https://reader.test').map((o) => o.action.id), ['share'])
})
