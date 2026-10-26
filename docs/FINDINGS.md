# Findings: what breaks in partitioned iframes

Working notes for the "learn what breaks" goal. Entries marked **expected**
come from reading library code and specs and still need checking in Chrome.
Change them to **observed** with the Chrome version once seen.

## Setup that makes the test meaningful

The shell runs on `localhost` and the demo app on `127.0.0.1`. Those are
different sites, so Chrome treats the framed app as third-party and partitions
its storage (IndexedDB, localStorage, BroadcastChannel, service workers) by the
top-level site.

## 1. The OAuth library's popup sign-in

**Expected: breaks.** `BrowserOAuthClient.signInPopup()` in
`@atproto/oauth-client-browser` 0.5.x sends the result from the popup to the
opener over a `BroadcastChannel`, and the popup finishes the callback itself.
The popup is top-level (unpartitioned); the frame is partitioned. They can't
hear each other on BroadcastChannel, and the popup can't see the PKCE
verifier or DPoP key the frame stored.

**Workaround used:** the frame calls `client.authorize()` itself, opens the
popup synchronously at `callback.html#relay=<key>`, then points it at the
authorization URL. The callback page forwards the redirect params back via
`window.opener.postMessage` when the opener link survives, and always via a
one-time relay on the app's own server. The frame then calls
`client.callback()` in its own partition. See `app/src/sessions.ts`.

To check: does the auth server's COOP sever `window.opener`? The event log
shows "callback via postMessage" or "callback via server relay".

**Observed (Chrome, version not yet recorded, 2026-10-26, Tim):** with
bsky.social as the auth server, the frame's handle on the popup reported
`closed === true` about two seconds after the popup was sent to the
authorization URL, while the popup was still open and sign-in went on. The
first version of the relay treated that as "Sign-in window closed" and gave
up, so finishing sign-in in the popup did nothing. This fits COOP putting
the popup in a new browsing context group, which also severs the opener.

**Fix (observed working, Chrome, version not yet recorded, 2026-10-26,
Tim):** `waitForRelay` no longer
trusts `popup.closed`. It logs "popup handle reports closed (COOP?)" once
and keeps polling the relay until the 5-minute deadline. The cost: if the
user really closes the popup, the frame waits out the deadline (another
click starts a fresh sign-in).

## 2. Two frames of the same app

**Expected:** both frames share one partition (same app origin, same top-level
site). Sessions added in one appear in the other after a reload, and the
library's refresh locks coordinate across them. Open the demo app twice in
the shell to check.

## 3. Sessions inside vs outside the shell

**Expected:** signing in to the demo app at top level
(`http://127.0.0.1:5171/`) and inside the shell gives two separate sets of
sessions, because the framed copy's storage is keyed by the shell's site. To
users that looks like being "logged out" in the shell. A real deployment would
want the Storage Access API or a per-app explanation.

## 4. FedCM in the frame

- **Expected:** `allow="identity-credentials-get"` on the iframe is required;
  without it `navigator.credentials.get` rejects with a permissions error.
- **Expected:** after the FedCM call, the click's user activation is used up,
  so the Phase 1 OAuth popup needs a second click. Phase 2 has no popup.
- **To check:** whether Chrome on localhost needs the well-known check
  disabled (see README), and whether `params` reaches the assertion endpoint
  in the installed Chrome version.

## Open questions for a real FedCM profile (Phase 2)

- **Discovery:** an app can't hard-code every PDS's config URL. Options are
  resolving the user's handle first (but FedCM is meant to come before the
  app knows the user), FedCM's experimental IdP registration, or an entryway
  such as bsky.social acting as one IdP for its PDSes.
- **Client identity:** this prototype uses the app's origin as `client_id`.
  Real atproto clients use a URL to client metadata; the PDS would have to
  fetch it and check that the FedCM `Origin` is allowed by it.
- **DPoP nonces:** real PDSes require server-issued DPoP nonces; the mock
  skips them.
- **Consent:** FedCM's chooser is not an OAuth consent screen. Scopes beyond
  `atproto` probably still need an explicit grant step.
