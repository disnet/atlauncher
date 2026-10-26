// The demo app's atproto OAuth client identity, shared by the browser code
// and the app server.
//
// Locally the app is a "loopback" client (client_id = http://localhost?...),
// which needs no hosted metadata but only works on 127.0.0.1. Deployed, it
// is a web client whose client_id is the URL of the metadata below, which
// the app server publishes.

import type { OAuthClientMetadataInput } from '@atproto/oauth-client-browser'
import { APP_ORIGIN } from '../lib/config.ts'

// Granular scopes: only the two calls the demo makes through the user's
// PDS, both to the Bluesky AppView (getProfile at sign-in, unread counts
// for the badges). Plain `atproto` would let it call neither.
export const APPVIEW = 'did:web:api.bsky.app#bsky_appview'
const APPVIEW_AUD = APPVIEW.replace('#', '%23')
export const SCOPE = [
  'atproto',
  `rpc:app.bsky.actor.getProfile?aud=${APPVIEW_AUD}`,
  `rpc:app.bsky.notification.getUnreadCount?aud=${APPVIEW_AUD}`,
].join(' ')
// Typed as https for the OAuth library; locally it is http://127.0.0.1, which
// loopback clients may use.
export const REDIRECT_URI = `${APP_ORIGIN}/callback.html` as `https://${string}`
export const CLIENT_METADATA_PATH = '/oauth-client-metadata.json'

export const IS_LOOPBACK = new URL(APP_ORIGIN).hostname === '127.0.0.1'

export const CLIENT_ID = IS_LOOPBACK
  ? `http://localhost?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPE)}`
  : `${APP_ORIGIN}${CLIENT_METADATA_PATH}`

export const clientMetadata = (): OAuthClientMetadataInput => ({
  client_id: CLIENT_ID,
  client_name: 'atworkplace demo app',
  client_uri: APP_ORIGIN,
  redirect_uris: [REDIRECT_URI],
  scope: SCOPE,
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  application_type: 'web',
  dpop_bound_access_tokens: true,
})
