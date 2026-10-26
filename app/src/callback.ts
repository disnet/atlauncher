// OAuth popup callback page. It never touches tokens: it only forwards the
// redirect parameters back to the frame that started the sign-in.
//
// Visit 1 (#relay=<key>): the frame opened us; remember the relay key in this
// tab's sessionStorage, which survives the trip to the auth server and back.
// Visit 2 (?code=...&state=...&iss=...): forward the params, then close.

const msg = document.getElementById('msg')!
const KEY = 'awp.relay'

const hashKey = new URLSearchParams(location.hash.slice(1)).get('relay')
if (hashKey) {
  sessionStorage.setItem(KEY, hashKey)
} else if (location.search) {
  const relay = sessionStorage.getItem(KEY)
  sessionStorage.removeItem(KEY)
  const search = location.search.slice(1)
  if (!relay) {
    msg.textContent = 'This sign-in window lost track of which app started it. Close it and try again.'
  } else {
    // Path A: direct, if the auth server didn't sever window.opener (COOP).
    try {
      window.opener?.postMessage({ type: 'oauth-callback', relay, search }, location.origin)
    } catch {}
    // Path B: via our own server, which works across storage partitions.
    fetch(`/relay/${encodeURIComponent(relay)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ search }),
    })
      .then(() => {
        msg.textContent = 'Signed in. You can close this window.'
        setTimeout(() => window.close(), 300)
      })
      .catch(() => {
        msg.textContent = 'Could not hand the sign-in back to the app.'
      })
  }
}
