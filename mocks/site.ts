// Server for the mock partner apps (Skyreader, Reams, Roomy). They're
// static pages with fake data; each runs on its own origin, and this only
// adds the header that lets the shell frame them.
//
// Runtime-neutral: mocks/server.ts runs it under Node, deploy/ on Workers.

import { SHELL_ORIGIN, type MockApp } from '../lib/config.ts'
import type { Site } from '../lib/http.ts'

export function mockSite(app: MockApp): Site {
  return {
    name: app,
    handlers: [],
    assetHeaders: () => ({ 'content-security-policy': `frame-ancestors 'self' ${SHELL_ORIGIN}` }),
  }
}
