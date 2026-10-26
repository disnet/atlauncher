// The prototype's pieces that run without a browser: saved-workspace
// validation, the framing probe, and the shell API that stores apps.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dispatch } from '../lib/http.ts'
import { memoryTables } from '../lib/store.ts'
import { framingVerdict, pageInfo } from '../shell/probe.ts'
import { shellSite } from '../shell/site.ts'
import { appUrl, parseWorkspace } from '../shell/src/workspace.ts'

const shell = 'https://shell.example'
const app = 'https://app.example'
const verdict = (h: Record<string, string>) => framingVerdict(new Headers(h), app, shell).frameable

test('appUrl accepts http(s) and bare hosts only', () => {
  assert.equal(appUrl('bsky.app'), 'https://bsky.app/')
  assert.equal(appUrl(' http://127.0.0.1:5171/x '), 'http://127.0.0.1:5171/x')
  assert.equal(appUrl('javascript:alert(1)'), null)
  assert.equal(appUrl('data:text/html,hi'), null)
  assert.equal(appUrl(''), null)
})

test('parseWorkspace keeps valid apps and rejects the rest', () => {
  assert.deepEqual(parseWorkspace({ apps: [], profile: null }), { apps: [], profile: null })
  const ws = parseWorkspace({ apps: [{ id: 'a', url: 'https://x.example', name: 'X', extra: 1 }], profile: 'did:plc:alice' })
  assert.deepEqual(ws, { apps: [{ id: 'a', url: 'https://x.example/', name: 'X' }], profile: 'did:plc:alice' })
  assert.equal(parseWorkspace({ apps: [{ id: 'a', url: 'javascript:1' }], profile: null }), null)
  assert.equal(parseWorkspace({ apps: [], profile: 'alice' }), null)
  assert.equal(parseWorkspace({ apps: Array.from({ length: 31 }, (_, i) => ({ id: `${i}`, url: 'https://x.example' })), profile: null }), null)
  // A non-http icon is dropped, not trusted.
  assert.deepEqual(parseWorkspace({ apps: [{ id: 'a', url: 'https://x.example', icon: 'javascript:1' }] })?.apps[0], {
    id: 'a',
    url: 'https://x.example/',
  })
})

test('framingVerdict reads X-Frame-Options and frame-ancestors', () => {
  assert.equal(verdict({}), true)
  assert.equal(verdict({ 'x-frame-options': 'DENY' }), false)
  assert.equal(verdict({ 'x-frame-options': 'sameorigin' }), false)
  assert.equal(verdict({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), false)
  assert.equal(verdict({ 'content-security-policy': "frame-ancestors 'self'" }), false)
  assert.equal(verdict({ 'content-security-policy': `frame-ancestors 'self' ${shell}` }), true)
  assert.equal(verdict({ 'content-security-policy': 'frame-ancestors https://*.example' }), true)
  assert.equal(verdict({ 'content-security-policy': 'frame-ancestors https:' }), true)
  assert.equal(verdict({ 'content-security-policy': 'frame-ancestors *' }), true)
  assert.equal(verdict({ 'content-security-policy': 'frame-ancestors https://other.example' }), false)
  assert.equal(verdict({ 'content-security-policy': 'frame-ancestors https://shell.example:8443' }), false)
  // frame-ancestors overrides X-Frame-Options, as in browsers.
  assert.equal(verdict({ 'x-frame-options': 'DENY', 'content-security-policy': `frame-ancestors ${shell}` }), true)
  // Without frame-ancestors, other CSP directives don't matter.
  assert.equal(verdict({ 'content-security-policy': "default-src 'none'" }), true)
})

test('pageInfo finds a title and icon', () => {
  const page = `<head><title>Reams &amp; notes</title><link rel="shortcut icon" href="/fav.png">
    <link href='/touch.png' rel="apple-touch-icon"><link rel="icon" href="javascript:x"></head>`
  assert.deepEqual(pageInfo(page, 'https://r.example/app/'), { title: 'Reams & notes', icon: 'https://r.example/touch.png' })
  assert.deepEqual(pageInfo('', 'https://r.example/'), {})
})

// ---- the shell API, over a real probe target -------------------------------------------

let target: Server
let targetUrl = ''
before(async () => {
  target = createServer((req, res) => {
    if (req.url === '/deny') res.setHeader('x-frame-options', 'DENY')
    res.setHeader('content-type', 'text/html')
    res.end('<title>Target</title><link rel=icon href=/i.png>')
  })
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`
})
after(() => target.close())

test('shell API: workspace round-trips per session, probe reports framing', async () => {
  const site = shellSite(memoryTables())
  const call = (path: string, init: RequestInit = {}, cookie = '') =>
    dispatch(site, new Request(`http://localhost:5170${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } }))

  const first = await call('/api/workspace')
  assert.deepEqual(await first.json(), { apps: [], profile: null })
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]

  const ws = { apps: [{ id: 'a', url: `${targetUrl}/` }], profile: 'did:plc:alice' }
  const put = await call('/api/workspace', { method: 'PUT', body: JSON.stringify(ws), headers: { 'content-type': 'application/json' } }, cookie)
  assert.equal(put.status, 200)
  assert.deepEqual(await (await call('/api/workspace', {}, cookie)).json(), ws)
  // Another session sees its own, empty workspace.
  assert.deepEqual(await (await call('/api/workspace')).json(), { apps: [], profile: null })
  assert.equal((await call('/api/workspace', { method: 'PUT', body: '{"apps":"x"}' }, cookie)).status, 400)
  // Cross-site pages can't read or write it.
  assert.equal((await call('/api/workspace', { headers: { 'sec-fetch-site': 'cross-site' } }, cookie)).status, 403)

  const ok = await (await call(`/api/probe?url=${encodeURIComponent(`${targetUrl}/`)}`, {}, cookie)).json()
  assert.equal(ok.frameable, true)
  assert.equal(ok.title, 'Target')
  assert.equal(ok.icon, `${targetUrl}/i.png`)
  const deny = await (await call(`/api/probe?url=${encodeURIComponent(`${targetUrl}/deny`)}`, {}, cookie)).json()
  assert.equal(deny.frameable, false)
  assert.equal(deny.reason, 'X-Frame-Options: DENY')
  const down = await (await call('/api/probe?url=http%3A%2F%2F127.0.0.1%3A1%2F', {}, cookie)).json()
  assert.equal(down.frameable, null)
  assert.equal((await call('/api/probe?url=javascript%3A1', {}, cookie)).status, 400)

  assert.equal((await call('/demo')).headers.get('location'), '/demo/')
})
