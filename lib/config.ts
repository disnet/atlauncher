// Origins for the prototype.
//
// Locally, the demo app lives on 127.0.0.1 for two reasons:
//  1. atproto OAuth "loopback" clients (client_id = http://localhost?...) must
//     redirect to 127.0.0.1, so local dev needs no hosted client metadata.
//  2. localhost and 127.0.0.1 are different *sites*, so the app framed inside
//     the shell is genuinely cross-site and Chrome partitions its storage,
//     the same way it would for atworkplace.app framing bsky-client.example.
//
// The deploy build (deploy/build.ts) replaces __ATWORKPLACE_ORIGINS__ with
// the three deployed origins, in both browser and server bundles. Under Node,
// the ATWORKPLACE_ORIGINS environment variable (the same JSON) points the
// tests at a deployment instead of the local servers.

type Origins = { shell: string; app: string; pds: string }
declare const __ATWORKPLACE_ORIGINS__: Origins | undefined
const fromEnv = typeof process === 'object' ? process.env?.ATWORKPLACE_ORIGINS : undefined
const deployed: Origins | undefined =
  typeof __ATWORKPLACE_ORIGINS__ === 'object' ? __ATWORKPLACE_ORIGINS__ : fromEnv ? JSON.parse(fromEnv) : undefined

export const SHELL_PORT = 5170
export const APP_PORT = 5171
export const PDS_PORT = 5172

export const SHELL_ORIGIN = deployed?.shell ?? `http://localhost:${SHELL_PORT}`
export const APP_ORIGIN = deployed?.app ?? `http://127.0.0.1:${APP_PORT}`
export const PDS_ORIGIN = deployed?.pds ?? `http://localhost:${PDS_PORT}`
