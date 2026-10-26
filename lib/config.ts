// Origins for the local prototype.
//
// The demo app lives on 127.0.0.1 for two reasons:
//  1. atproto OAuth "loopback" clients (client_id = http://localhost?...) must
//     redirect to 127.0.0.1, so local dev needs no hosted client metadata.
//  2. localhost and 127.0.0.1 are different *sites*, so the app framed inside
//     the shell is genuinely cross-site and Chrome partitions its storage,
//     the same way it would for atworkplace.app framing bsky-client.example.

export const SHELL_PORT = 5170
export const APP_PORT = 5171
export const PDS_PORT = 5172

export const SHELL_ORIGIN = `http://localhost:${SHELL_PORT}`
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`
export const PDS_ORIGIN = `http://localhost:${PDS_PORT}`
