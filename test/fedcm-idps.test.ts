// Drives both FedCM identity providers the way Chrome would, over real HTTP.
// Browser-only parts (the account chooser UI, partitioning) are not covered
// here; see docs/FINDINGS.md for the manual checks.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { APP_ORIGIN, PDS_ORIGIN, SHELL_ORIGIN } from '../lib/config.ts'
import { start as startShell } from '../shell/server.ts'
import { start as startPds, MOCK_ACCOUNTS } from '../mock-pds/server.ts'
import { start as startApp } from '../app/server.ts'
import { dpopProof, generateDpopKey, pkcePair } from '../app/src/dpop.ts'
import { parsePdsAssertion, parseShellAssertion } from '../protocol/messages.ts'

let servers: Server[] = []
before(async () => {
  servers = [startShell(), startPds(), startApp()]
  await Promise.all(servers.map((s) => new Promise((r) => (s.listening ? r(null) : s.once('listening', r)))))
})
after(() => servers.forEach((s) => s.close()))

const webidentity = { 'sec-fetch-dest': 'webidentity' }
const cookieFrom = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]

test('shell: config and well-known', async () => {
  const cfg = await (await fetch(`${SHELL_ORIGIN}/fedcm/config.json`)).json()
  assert.equal(cfg.id_assertion_endpoint, `${SHELL_ORIGIN}/fedcm/assertion`)
})

test('both IdPs: well-known names exactly their own config and endpoints', async () => {
  // Chrome rejects a well-known file with more than one config URL, and wants
  // accounts_endpoint and login_url repeated when client_metadata is used.
  for (const origin of [SHELL_ORIGIN, PDS_ORIGIN]) {
    const cfg = await (await fetch(`${origin}/fedcm/config.json`)).json()
    const wk = await (await fetch(`${origin}/.well-known/web-identity`)).json()
    assert.deepEqual(wk.provider_urls, [`${origin}/fedcm/config.json`])
    assert.equal(wk.accounts_endpoint, cfg.accounts_endpoint)
    assert.equal(wk.login_url, cfg.login_url)
  }
})

test('shell: accounts → assertion returns a hint for the chosen DID', async () => {
  // A fresh shell session with one account.
  const first = await fetch(`${SHELL_ORIGIN}/api/accounts`)
  const cookie = cookieFrom(first)
  assert.match(cookie, /^awp_sid=/)
  assert.equal(first.headers.get('set-login'), 'logged-out')

  const did = 'did:plc:testalice'
  const added = await fetch(`${SHELL_ORIGIN}/api/accounts`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ did, handle: 'alice.test', displayName: 'Alice' }),
  })
  assert.equal(added.headers.get('set-login'), 'logged-in')

  // Not a FedCM request → refused.
  assert.equal((await fetch(`${SHELL_ORIGIN}/fedcm/accounts`, { headers: { cookie } })).status, 400)

  const accounts = await (await fetch(`${SHELL_ORIGIN}/fedcm/accounts`, { headers: { cookie, ...webidentity } })).json()
  assert.equal(accounts.accounts[0].id, did)
  assert.deepEqual(accounts.accounts[0].login_hints, [did, 'alice.test'])

  const assertion = (extra: Record<string, string>, origin = APP_ORIGIN) =>
    fetch(`${SHELL_ORIGIN}/fedcm/assertion`, {
      method: 'POST',
      headers: { cookie, origin, ...webidentity, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: APP_ORIGIN, account_id: did, params: JSON.stringify({ nonce: 'n1' }), ...extra }),
    })

  const ok = await assertion({})
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('access-control-allow-origin'), APP_ORIGIN)
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true')
  const hint = parseShellAssertion((await ok.json()).token)
  assert.equal(hint?.did, did)
  assert.equal(hint?.nonce, 'n1')

  assert.equal((await assertion({}, 'https://evil.example')).status, 403) // unapproved RP
  assert.equal((await assertion({ client_id: 'https://other.example' })).status, 403) // client_id ≠ Origin
  assert.equal((await assertion({ account_id: 'did:plc:someoneelse' })).status, 401)
})

test('mock PDS: FedCM code → DPoP token → authenticated XRPC call', async () => {
  const alice = MOCK_ACCOUNTS[0]
  // "Sign in" on the PDS login page.
  const login = await fetch(`${PDS_ORIGIN}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ [alice.did]: 'on' }),
  })
  assert.equal(login.headers.get('set-login'), 'logged-in')
  assert.equal(login.headers.get('content-security-policy'), `frame-ancestors 'none'`)
  const cookie = cookieFrom(login)

  const accounts = await (await fetch(`${PDS_ORIGIN}/fedcm/accounts`, { headers: { cookie, ...webidentity } })).json()
  assert.deepEqual(accounts.accounts.map((a: { id: string }) => a.id), [alice.did])

  const key = await generateDpopKey()
  const pkce = await pkcePair()
  const res = await fetch(`${PDS_ORIGIN}/fedcm/assertion`, {
    method: 'POST',
    headers: { cookie, origin: APP_ORIGIN, ...webidentity, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: APP_ORIGIN,
      account_id: alice.did,
      params: JSON.stringify({ nonce: 'n', scope: 'atproto', code_challenge: pkce.challenge, code_challenge_method: 'S256', dpop_jkt: key.jkt }),
    }),
  })
  assert.equal(res.status, 200)
  const a = parsePdsAssertion((await res.json()).token)!
  assert.equal(a.sub, alice.did)

  const exchange = async (code: string, verifier: string, k = key) =>
    fetch(a.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: await dpopProof(k, 'POST', a.token_endpoint) },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: APP_ORIGIN }),
    })

  // A different DPoP key can't redeem the code (it's bound to dpop_jkt).
  const thief = await exchange(a.code, pkce.verifier, await generateDpopKey())
  assert.equal(thief.status, 400)
  assert.equal((await thief.json()).error, 'invalid_dpop_proof')
  // …and that attempt burned the single-use code, as it should.
  assert.equal((await exchange(a.code, pkce.verifier)).status, 400)

  // Fresh code, right key, wrong PKCE verifier → rejected; then the real thing.
  const fresh = async () => {
    const r = await fetch(`${PDS_ORIGIN}/fedcm/assertion`, {
      method: 'POST',
      headers: { cookie, origin: APP_ORIGIN, ...webidentity, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: APP_ORIGIN,
        account_id: alice.did,
        params: JSON.stringify({ nonce: 'n', code_challenge: pkce.challenge, code_challenge_method: 'S256', dpop_jkt: key.jkt }),
      }),
    })
    return parsePdsAssertion((await r.json()).token)!.code
  }
  assert.equal((await exchange(await fresh(), 'wrong-verifier')).status, 400)
  const tokRes = await exchange(await fresh(), pkce.verifier)
  assert.equal(tokRes.status, 200)
  const tok = await tokRes.json()
  assert.equal(tok.token_type, 'DPoP')
  assert.equal(tok.sub, alice.did)

  const profileUrl = `${PDS_ORIGIN}/xrpc/app.bsky.actor.getProfile?actor=${alice.did}`
  const call = async (token: string, k = key) =>
    fetch(profileUrl, { headers: { authorization: `DPoP ${token}`, DPoP: await dpopProof(k, 'GET', profileUrl, token) } })

  const profile = await call(tok.access_token)
  assert.equal(profile.status, 200)
  assert.equal((await profile.json()).handle, alice.handle)
  // A stolen access token is useless without the key.
  assert.equal((await call(tok.access_token, await generateDpopKey())).status, 401)

  // Refresh rotates and stays bound to the same key.
  const refreshed = await fetch(a.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: await dpopProof(key, 'POST', a.token_endpoint) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: APP_ORIGIN }),
  })
  assert.equal(refreshed.status, 200)
  assert.equal((await call((await refreshed.json()).access_token)).status, 200)
})

test('mock PDS: refuses unapproved apps and missing PKCE/DPoP binding', async () => {
  const bob = MOCK_ACCOUNTS[1]
  const login = await fetch(`${PDS_ORIGIN}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ [bob.did]: 'on' }),
  })
  const cookie = cookieFrom(login)
  const ask = (origin: string, params: object) =>
    fetch(`${PDS_ORIGIN}/fedcm/assertion`, {
      method: 'POST',
      headers: { cookie, origin, ...webidentity, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: origin, account_id: bob.did, params: JSON.stringify(params) }),
    })
  assert.equal((await ask('https://evil.example', {})).status, 403)
  assert.equal((await ask(APP_ORIGIN, { dpop_jkt: 'x' })).status, 400) // no PKCE
  assert.equal((await ask(APP_ORIGIN, { code_challenge: 'c', code_challenge_method: 'S256' })).status, 400) // no dpop_jkt
})

test('app: frame-ancestors allows the shell; relay is single-read', async () => {
  const page = await fetch(`${APP_ORIGIN}/`)
  assert.equal(page.headers.get('content-security-policy'), `frame-ancestors 'self' ${SHELL_ORIGIN}`)
  const cb = await fetch(`${APP_ORIGIN}/callback.html`)
  assert.equal(cb.headers.get('content-security-policy'), `frame-ancestors 'none'`)

  const key = crypto.randomUUID()
  assert.equal((await fetch(`${APP_ORIGIN}/relay/${key}`)).status, 204)
  const post = await fetch(`${APP_ORIGIN}/relay/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ search: 'code=abc&state=xyz' }),
  })
  assert.equal(post.status, 200)
  assert.equal((await (await fetch(`${APP_ORIGIN}/relay/${key}`)).json()).search, 'code=abc&state=xyz')
  assert.equal((await fetch(`${APP_ORIGIN}/relay/${key}`)).status, 204) // gone
  assert.equal((await fetch(`${APP_ORIGIN}/relay/${key}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
})
