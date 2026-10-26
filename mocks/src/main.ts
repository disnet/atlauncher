// Entry point for the mock partner apps. One bundle serves all three; which
// app runs depends on the origin it was loaded from.

import { MOCK_ORIGINS, type MockApp as MockAppName } from '../../lib/config.ts'
import { start, type MockApp } from './bridge.ts'
import { reams } from './reams.ts'
import { roomy, startIncoming } from './roomy.ts'
import { skyreader } from './skyreader.ts'

const APPS: Record<MockAppName, MockApp> = { skyreader, reams, roomy }

const name = (Object.keys(MOCK_ORIGINS) as MockAppName[]).find((m) => MOCK_ORIGINS[m] === location.origin) ?? 'skyreader'
start(APPS[name], document.getElementById('app')!)
if (name === 'roomy') startIncoming()
