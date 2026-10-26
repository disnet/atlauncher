// Runs the mock PDS (mock-pds/site.ts) under Node for local development.

import { PDS_PORT } from '../lib/config.ts'
import { startServer } from '../lib/node.ts'
import { memoryTables } from '../lib/store.ts'
import { pdsSite } from './site.ts'

export { MOCK_ACCOUNTS } from './site.ts'

export const start = () => startServer(pdsSite(memoryTables()), PDS_PORT)
