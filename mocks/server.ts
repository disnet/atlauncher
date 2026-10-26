// Runs the mock partner apps (mocks/site.ts) under Node, one port each.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_APPS, MOCK_PORTS } from '../lib/config.ts'
import { startServer } from '../lib/node.ts'
import { mockSite } from './site.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const start = () =>
  MOCK_APPS.map((app) =>
    startServer(mockSite(app), MOCK_PORTS[app], [
      ['/dist/', join(here, '..', 'dist', 'mocks')],
      ['/', join(here, 'public')],
    ]),
  )
