# atlauncher (working name: atworkplace)

A prototype of a plain web page that frames your atproto apps side by side and
switches accounts across them, like Rambox does with Electron, but using
browser features: atproto OAuth sessions keyed by DID, a small postMessage
protocol, and [FedCM](https://developer.mozilla.org/en-US/docs/Web/API/FedCM_API)
for picking accounts inside frames.

It runs in two phases:

- **Phase 1, works with today's network.** The shell is a FedCM identity
  provider whose accounts are the atproto accounts you've added to it. A
  framed app asks the shell which account to use, then signs in to that
  account's real PDS with normal atproto OAuth in a popup.
- **Phase 2, the design that would remove the popup.** A mock PDS
  authorization server is the FedCM identity provider. Its FedCM response is
  an OAuth authorization code bound to the app's DPoP key, so signing in is
  one click and the shell isn't involved at all.

The plan and goals are tracked in atplan:
`at://did:plc:4vjd3fe2cgzq5d24j4f3zvar/com.disnetdev.atplan.plan/atworkplace`.

## Run it

Needs Node 22+ and a recent Chrome or Edge (FedCM is Chromium-only).

```sh
npm install
npm run dev
```

| | URL |
|---|---|
| Shell | http://localhost:5170 |
| Demo app (framed by the shell) | http://127.0.0.1:5171 |
| Mock PDS login (Phase 2) | http://localhost:5172/login |

The app runs on `127.0.0.1` so it can use an atproto *loopback* OAuth client
(no hosted client metadata needed), and so it is cross-site from the shell and
gets partitioned storage, like a real deployment would.

### Chrome setup

FedCM requires the identity provider to publish `/.well-known/web-identity`
naming exactly one config URL. Each local IdP serves its own on its port,
and in Chromium 153 that was enough without any flag. If Chrome still
rejects the FedCM call with a well-known or config error, enable
`chrome://flags/#fedcm-without-well-known-enforcement` and restart Chrome.
The DevTools console of the framed app names the exact reason.

The shell and mock PDS set `SameSite=None; Secure` cookies. Chrome treats
`http://localhost` as a secure context, so this works without HTTPS.

## Try it

**Phase 1:**

1. Open the shell and add one or two Bluesky handles in the sidebar. This
   only names them.
2. In the demo app frame, click **Choose from atworkplace**. Chrome's account
   chooser lists the shell's accounts.
3. Pick one, then click **Continue** to sign in with Bluesky in the popup. A
   second click is needed because FedCM uses up the first one.
4. Add a second account the same way. Then switch between accounts with the
   sidebar or the frame's dropdown. No reload, no new sign-in.

**Phase 2:**

1. Open the mock PDS login page, tick Alice and Bob, and save.
2. In the demo app, click **Mock PDS account (Phase 2)**, pick an account in
   Chrome's chooser, and you're signed in. No popup, no redirect.

**Workspace features:** the shell opens the demo app twice, as "Posts"
and "Profiles".

1. With an account signed in, click **+1 unread** next to it in either
   frame. A badge shows on each frame using that account and on the account
   in the sidebar.
2. Under **Links** in Posts, open the account's profile. It opens in the
   Profiles frame. Paste an `at://` post URI in Profiles to see it open in
   Posts.

**Things to look for:** open the demo app twice in the shell; compare it
with the app opened at top level; read the event log in each frame. What
these should show, and what has actually been observed, is in
[docs/FINDINGS.md](docs/FINDINGS.md).

## Layout

```
protocol/messages.ts   shell ↔ app messages and FedCM token formats, with validators
shell/                 the atworkplace page, and its FedCM IdP endpoints (Phase 1)
app/                   the demo framed app: multi-session OAuth, popup relay, Phase 2 client
mock-pds/              PDS-style auth server that speaks FedCM + DPoP (Phase 2)
lib/                   origins and tiny HTTP helpers
docs/PROTOCOL.md       the protocol in prose
docs/FINDINGS.md       what breaks in partitioned iframes, and open questions
test/                  protocol tests and end-to-end tests of both IdPs over HTTP
```

```sh
npm test         # protocol + both FedCM IdPs + token exchange, over real HTTP
npm run typecheck
```

## Status and limits

- The tests drive the identity provider endpoints, the Phase 2 code → DPoP
  token → XRPC flow, and the popup relay over HTTP. The browser parts (Chrome's
  chooser, popups, partitioning) have not been run in a real browser yet. That
  is the next step, and FINDINGS.md is where results go.
- The shell's account list is a JSON file in `.data/`, keyed by a cookie.
- The mock PDS skips PAR, DPoP server nonces and client metadata, and keeps
  everything in memory.
- Real apps would need to opt in: allow the shell in `frame-ancestors`, hold
  several sessions keyed by DID, and speak `atworkplace/1`.
