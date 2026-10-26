import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROTO, collectionOf, handlesCollection, parseAppToShell, parseShellToApp } from '../protocol/messages.ts'
import { pickFrame, unreadByAccount } from '../shell/src/workspace.ts'

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
