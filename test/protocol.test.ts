import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTO,
  parseAppToShell,
  parsePdsAssertion,
  parseShellAssertion,
  parseShellToApp,
} from '../protocol/messages.ts'

const did = 'did:plc:abc123'

test('accepts well-formed app → shell messages', () => {
  assert.ok(parseAppToShell({ proto: PROTO, type: 'hello', app: { name: 'x' }, sessions: [did], active: did }))
  assert.ok(parseAppToShell({ proto: PROTO, type: 'state', sessions: [], active: null }))
  assert.ok(parseAppToShell({ proto: PROTO, type: 'needs-sign-in', did }))
})

test('rejects other traffic and malformed messages', () => {
  assert.equal(parseAppToShell({ type: 'hello' }), null) // no proto
  assert.equal(parseAppToShell({ proto: 'other/1', type: 'state', sessions: [], active: null }), null)
  assert.equal(parseAppToShell({ proto: PROTO, type: 'state', sessions: ['not-a-did'], active: null }), null)
  assert.equal(parseAppToShell({ proto: PROTO, type: 'switch', account: { did, handle: 'a' } }), null) // wrong direction
  assert.equal(parseAppToShell('string'), null)
})

test('shell → app messages', () => {
  assert.ok(parseShellToApp({ proto: PROTO, type: 'switch', account: { did, handle: 'a.test' } }))
  assert.ok(parseShellToApp({ proto: PROTO, type: 'sign-out', did }))
  assert.equal(parseShellToApp({ proto: PROTO, type: 'switch', account: { did: 'x', handle: 'a' } }), null)
  assert.equal(parseShellToApp({ proto: PROTO, type: 'hello', app: { name: 'x' }, sessions: [], active: null }), null)
})

test('FedCM token payloads', () => {
  const hint = JSON.stringify({ kind: 'atworkplace.account-hint', did, handle: 'a.test', nonce: 'n' })
  assert.deepEqual(parseShellAssertion(hint)?.did, did)
  assert.equal(parseShellAssertion('{"kind":"atproto.oauth-code"}'), null)
  assert.equal(parseShellAssertion('not json'), null)
  const code = JSON.stringify({ kind: 'atproto.oauth-code', code: 'c', iss: 'http://x', token_endpoint: 'http://x/t', sub: did })
  assert.equal(parsePdsAssertion(code)?.code, 'c')
  assert.equal(parsePdsAssertion(hint), null)
})
