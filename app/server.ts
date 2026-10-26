// Runs the demo app (app/site.ts) under Node for local development.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_PORT } from '../lib/config.ts'
import { startServer } from '../lib/node.ts'
import { memoryTables } from '../lib/store.ts'
import { appSite } from './site.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const start = () =>
  startServer(appSite(memoryTables()), APP_PORT, [
    ['/dist/', join(here, '..', 'dist', 'app')],
    ['/', join(here, 'public')],
  ])
