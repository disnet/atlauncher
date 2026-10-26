// One command for the whole prototype: rebuild browser code on change and
// run the shell, demo app, mock PDS and mock app servers.

import * as esbuild from 'esbuild'
import { APP_ORIGIN, MOCK_ORIGINS, PDS_ORIGIN, SHELL_ORIGIN } from '../lib/config.ts'
import { start as startApp } from '../app/server.ts'
import { start as startPds } from '../mock-pds/server.ts'
import { start as startMocks } from '../mocks/server.ts'
import { start as startShell } from '../shell/server.ts'
import { buildOptions } from './build.ts'

const ctx = await esbuild.context(buildOptions)
await ctx.rebuild()
await ctx.watch()

startShell()
startApp()
startPds()
startMocks()

console.log(`
  atworkplace shell   ${SHELL_ORIGIN}
  demo app            ${APP_ORIGIN}
  mock PDS (phase 2)  ${PDS_ORIGIN}/login
  mock apps           ${MOCK_ORIGINS.skyreader} (Skyreader), ${MOCK_ORIGINS.reams} (Reams), ${MOCK_ORIGINS.roomy} (Roomy)

  Open the shell in Chrome. See README.md for the Chrome flags FedCM needs on localhost.
`)
