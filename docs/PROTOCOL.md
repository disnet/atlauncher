# atworkplace/1: shell ↔ app protocol

A shell page frames atproto apps from other origins. This protocol lets the
shell ask a framed app to use a particular account, and lets the app report
which accounts it holds. Types and validators live in
[`protocol/messages.ts`](../protocol/messages.ts).

## Principles

1. **The shell names accounts; it never holds credentials.** Messages carry a
   DID and handle. Each app gets its own OAuth grant, with its own consent and
   scopes, from the account's authorization server.
2. **Both sides check origins.** The shell only accepts messages from a frame
   whose `contentWindow` is the event source *and* whose origin matches the URL
   it loaded. The app only accepts messages from `window.parent` with an origin
   on its trusted-shell list, and posts to the shell with an explicit
   `targetOrigin`, so a different parent receives nothing.
3. **Signing in needs a click inside the frame.** Popups and FedCM's active
   mode need user activation in the frame itself. A `switch` to an account the
   app doesn't have results in a prompt in the app, not an automatic sign-in.

Every message has `proto: "atworkplace/1"` and a `type`.

## App → shell

| type | fields | when |
|---|---|---|
| `hello` | `app.name`, `sessions: Did[]`, `active: Did \| null`, `handles?: string[]` | once, after the app restores its sessions |
| `state` | `sessions`, `active` | whenever either changes |
| `needs-sign-in` | `did` | after a `switch` the app can't complete without a click |
| `unread` | `counts: { did, count }[]` | whenever its unread counts change, as a full snapshot |
| `open` | `uri: AtUri`, `did?` | the user followed an `at://` link the app wants the workspace to show |

## Shell → app

| type | fields | effect |
|---|---|---|
| `switch` | `account: { did, handle }` | make it active, or prompt "Continue as @handle" |
| `sign-out` | `did` | revoke and forget that account's session in the app |
| `open` | `uri: AtUri`, `account?: { did, handle }` | show that record, as that account if given (same rules as `switch`) |

Which account a frame shows belongs to the shell. Frames of the same app
share storage, so an app's own idea of "active" is whatever any of its
frames picked last. The shell saves each frame's account with its URL. When
a restored frame sends `hello` with a different `active`, the shell sends
`switch` for the saved account, if the frame has a session for it.

## Unread badges

An app reports unread counts per account in `unread`. An account left out
has none. The shell shows a badge on each frame for the account it shows,
and one on each account in the sidebar for the total across apps. Frames of
one app share storage and report the same counts, so the shell counts each
app origin once.

## Opening links across apps

`hello` may list `handles`: the collections whose records the app can show,
as NSIDs. A trailing `.*` covers a namespace (`app.bsky.feed.*`). Apps that
send no `handles` get no `open` messages.

When an app sends `open` with an `at://` URI, the shell picks a frame whose
app handles that URI's collection, preferring one already showing `did`. If
no open frame does, it opens a new frame of an app it has seen before that
does. If it knows none, it tells the user. The shell sends the chosen frame
`open`, with `account` when it knows the account named by `did`.

An app decides which links to hand to the shell. Links to its own records
can stay inside the app.

## FedCM tokens

### Phase 1: the shell as identity provider

The app calls

```js
navigator.credentials.get({ identity: { mode: 'active', providers: [{
  configURL: 'https://atworkplace.app/fedcm/config.json',
  clientId: location.origin,
  params: { nonce },
}]}})
```

The shell's assertion endpoint checks that the browser-supplied `Origin`
equals `client_id` and is an approved app, then returns:

```json
{ "kind": "atworkplace.account-hint", "did": "did:plc:…", "handle": "alice.bsky.social", "nonce": "…" }
```

This is a **hint**. The app then runs ordinary atproto OAuth with the handle
as `login_hint`. Whatever the shell says, the PDS decides who is signed in.

### Phase 2: a PDS authorization server as identity provider

The app generates a DPoP key and a PKCE pair, then calls FedCM with the PDS's
config URL and

```js
params: { nonce, scope: 'atproto', code_challenge, code_challenge_method: 'S256', dpop_jkt }
```

The PDS returns:

```json
{ "kind": "atproto.oauth-code", "code": "…", "iss": "https://pds.example", "token_endpoint": "https://pds.example/oauth/token", "sub": "did:plc:…" }
```

The code is single-use, short-lived, and bound to `client_id`, the PKCE
challenge and the DPoP key thumbprint. The app redeems it at `token_endpoint`
with a DPoP proof from the same key. A copied code is useless to anyone
without both the verifier and the private key.

Open questions for a real profile are in [FINDINGS.md](FINDINGS.md).
