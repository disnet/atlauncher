# atworkplace: a workspace for atproto apps

atworkplace is a web page that puts your atproto apps side by side and lets
you switch which account each app is using from one sidebar. It's Rambox for
the atmosphere, built with the apps rather than around them. An app joins
with one package and one HTTP header, and keeps its own OAuth grant and its
own tokens.

(The repo is still called atlauncher, its working name.)

## The problem

People who run more than one atproto account, such as a personal account
plus a project, community or brand account, have no good place to work.
Today they juggle browser profiles, private windows or an Electron wrapper
like Rambox. Each of those treats an account as a cookie jar, so switching
means switching windows. Nothing knows that the account in Leaflet and the
account in Tangled are the same person.

atproto already has the missing piece. Every account is a DID, and OAuth
sessions are held by the app and keyed by that DID. Apps that cooperate can
hold several accounts at once, so a shared shell only has to say which one
to show.

## What users get

- **One sidebar for all their accounts.** Pick an account for each app, or
  switch every app to the same account in one click. Each frame remembers
  its account across reloads.
- **Several apps open side by side.** Two frames of the same app can show
  two different accounts.
- **Unread badges per app and per account.** Each app reports its own
  counts, so the shell never scrapes page titles.
- **`at://` links that open in the right app.** A link to a record opens in
  whichever app in the workspace handles that kind of record. Rambox can't
  do this, because it doesn't know what a record is.
- **Nothing to install.** It's a web page, so it works on a Chromebook or a
  locked-down work laptop.

## What it costs an app

Joining takes two changes:

1. **Use the atworkplace SDK** (planned; for now the demo app's
   `app/src/sessions.ts` shows what it will do). It wraps
   `@atproto/oauth-client-browser` and handles several sessions keyed by
   DID, sign-in from inside a frame, token refresh shared safely between
   frames, and the shell's message protocol.
2. **Allow the workspace to frame you.** Add the workspace origin to your
   `Content-Security-Policy: frame-ancestors`.

What the app keeps:

| | How it works |
| --- | --- |
| Its OAuth grant | Each app signs in to the user's PDS itself, with its own consent screen and scopes. |
| Its tokens | They never leave the app. The shell only ever sees a DID and a handle. |
| Its UI | The shell asks the app to switch accounts. If the app doesn't hold that account yet, it shows its own "Continue as @handle" prompt. |
| Its users outside the shell | Nothing changes when the app runs in its own tab. |

## What's rough today

This works now with ordinary atproto OAuth, confirmed in Chrome 155 against
bsky.social. Three things are rougher than they will be later:

- **The first sign-in in each app uses a popup and takes two clicks.** The
  browser spends the first click on the account chooser.
- **Apps start signed out inside the workspace.** Browsers keep a framed
  app's storage separate from the same app in its own tab, so people sign in
  once more per app.
- **The in-frame account chooser (FedCM) only works in Chrome and Edge.** In
  other browsers, apps fall back to people typing a handle.

Once PDSes act as FedCM identity providers, the popup goes away and sign-in
becomes one click in the frame. This repo builds that flow against a mock
PDS (Phase 2 below), and it's being written up as a proposed profile for
atproto OAuth. Apps don't have to wait for it.

## Where it goes next

The protocol is versioned, so the shell can add features without breaking
apps that don't support them yet.

1. Account switching across apps (working).
2. Unread badges per app and account (in the demo).
3. Opening `at://` links in the app that handles that record type (in the
   demo).
4. Shared actions, such as "post this from account X" or "save this to
   Semble", sent from one app and handled by another.
5. One-click sign-in once PDSes support FedCM.

The plan and goals are tracked in atplan:
`at://did:plc:4vjd3fe2cgzq5d24j4f3zvar/com.disnetdev.atplan.plan/atworkplace`.

## How the prototype works

The shell frames apps from other origins and talks to them over a small
postMessage protocol, `atworkplace/1` ([docs/PROTOCOL.md](docs/PROTOCOL.md)).
Inside a frame, apps pick an account with
[FedCM](https://developer.mozilla.org/en-US/docs/Web/API/FedCM_API), in
one of two phases:

- **Phase 1, works with today's network.** The shell is a FedCM identity
  provider whose accounts are the atproto accounts you've added to it. A
  framed app asks the shell which account to use, then signs in to that
  account's real PDS with normal atproto OAuth in a popup.
- **Phase 2, the design that would remove the popup.** A mock PDS
  authorization server is the FedCM identity provider. Its FedCM response is
  an OAuth authorization code bound to the app's DPoP key, so signing in is
  one click and the shell isn't involved at all.

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

### Deployed

`npm run deploy` puts the three parts on Cloudflare Workers, each on its
own workers.dev subdomain. See [docs/DEPLOY.md](docs/DEPLOY.md).

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
  */site.ts            each server's routes, runtime-neutral (Fetch API Request/Response)
  */server.ts          runs it under Node for npm run dev
lib/                   origins, HTTP helpers, key-value tables, the Node runner
deploy/                Cloudflare Workers entries, D1 tables, build and deploy scripts
docs/PROTOCOL.md       the protocol in prose
docs/FINDINGS.md       what breaks in partitioned iframes, and open questions
docs/DEPLOY.md         deploying to Cloudflare
test/                  protocol tests and end-to-end tests of both IdPs over HTTP
```

```sh
npm test         # protocol + both FedCM IdPs + token exchange, over real HTTP
npm run typecheck
```

## Status and limits

- Phase 1 and Phase 2 have been checked in Chrome 155, including popup
  sign-in with bsky.social, two frames of one app, and token refresh across
  frames. [docs/FINDINGS.md](docs/FINDINGS.md) has what was seen.
- Unread badges and link opening have been checked in Playwright's Chromium,
  not yet with a real sign-in in Chrome.
- The shell's account list is a JSON file in `.data/`, keyed by a cookie
  (in D1 when deployed).
- The mock PDS skips PAR, DPoP server nonces and client metadata, and keeps
  everything in memory (in D1 when deployed).
