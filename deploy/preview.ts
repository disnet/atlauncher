// Runs the deploy build locally under wrangler dev, with a local D1, to
// check the Workers before deploying. Origins mirror npm run dev: the app
// on 127.0.0.1, so it is cross-site from the shell and a loopback client.

import { execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_APPS } from '../lib/config.ts'
import { build, OUT, SITES, type Origins, type SiteName } from './build.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = join(root, 'node_modules', '.bin', 'wrangler')
const STATE = join(root, 'deploy', '.wrangler-state')

const ports: Record<SiteName, number> = { shell: 8780, app: 8781, pds: 8782, skyreader: 8783, reams: 8784, roomy: 8785 }
const origins = {
  shell: `http://localhost:${ports.shell}`,
  app: `http://127.0.0.1:${ports.app}`,
  pds: `http://localhost:${ports.pds}`,
  ...Object.fromEntries(MOCK_APPS.map((m) => [m, `http://127.0.0.1:${ports[m]}`])),
} as Origins
const names = Object.fromEntries(SITES.map((s) => [s, `atworkplace-${s}`])) as Record<SiteName, string>

await build({ origins, names, db: { name: 'atworkplace', id: 'local' } })

// Each site gets its own local state: the sites never share rows, and
// wrangler dev processes can't share one persist directory.
for (const [i, site] of SITES.entries()) {
  const cwd = join(OUT, site)
  const persist = ['--persist-to', join(STATE, site)]
  execFileSync(WRANGLER, ['d1', 'execute', 'atworkplace', '--local', ...persist, '--file', join(root, 'deploy', 'schema.sql')], {
    cwd,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const port = ['--port', String(ports[site]), '--inspector-port', String(9230 + i), '--ip', '127.0.0.1']
  spawn(WRANGLER, ['dev', ...port, ...persist, '--show-interactive-dev-session=false'], { cwd, stdio: 'inherit' })
}

console.log(`
  atworkplace shell   ${origins.shell}
  demo app            ${origins.app}
  mock PDS (phase 2)  ${origins.pds}/login
  mock apps           ${MOCK_APPS.map((m) => origins[m]).join(', ')}
`)
