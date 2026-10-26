// Deploys the demo to Cloudflare as three Workers, one per origin, sharing
// one D1 database. Creates the database on first run. See docs/DEPLOY.md.
//
//   CLOUDFLARE_ACCOUNT_ID=… npm run deploy
//
// Optional: ATWORKPLACE_PREFIX (default "atworkplace") names the Workers
// <prefix>-shell, <prefix>-app, <prefix>-pds and the database <prefix>.
// SHELL_ORIGIN, APP_ORIGIN and PDS_ORIGIN override the workers.dev URLs,
// e.g. for custom domains.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, OUT, SITES, type Origins, type SiteName } from './build.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = join(root, 'node_modules', '.bin', 'wrangler')

const wrangler = (args: string[], opts: { cwd?: string; quiet?: boolean } = {}) =>
  execFileSync(WRANGLER, args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  })

const json = <T>(out: string): T => JSON.parse(out.slice(out.search(/[[{]/)))

const prefix = process.env.ATWORKPLACE_PREFIX ?? 'atworkplace'
const names = Object.fromEntries(SITES.map((s) => [s, `${prefix}-${s}`])) as Record<SiteName, string>

// ---- account and workers.dev subdomain -------------------------------------

function pickAccount() {
  const who = json<{ accounts: { id: string; name: string }[] }>(wrangler(['whoami', '--json'], { quiet: true }))
  if (who.accounts.length === 1) return who.accounts[0].id
  console.error('Set CLOUDFLARE_ACCOUNT_ID to one of:')
  for (const a of who.accounts) console.error(`  ${a.id}  ${a.name}`)
  process.exit(1)
}
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? pickAccount()
process.env.CLOUDFLARE_ACCOUNT_ID = accountId

async function workersSubdomain() {
  const { token } = json<{ token?: string }>(wrangler(['auth', 'token', '--json'], { quiet: true }))
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  const body = (await res.json()) as { result?: { subdomain?: string } }
  if (!body.result?.subdomain) throw new Error(`No workers.dev subdomain for account ${accountId}: ${JSON.stringify(body)}`)
  return body.result.subdomain
}

const env = process.env
const needsSubdomain = !(env.SHELL_ORIGIN && env.APP_ORIGIN && env.PDS_ORIGIN)
const sub = needsSubdomain ? await workersSubdomain() : ''
const dev = (site: SiteName) => `https://${names[site]}.${sub}.workers.dev`
const origins: Origins = {
  shell: env.SHELL_ORIGIN ?? dev('shell'),
  app: env.APP_ORIGIN ?? dev('app'),
  pds: env.PDS_ORIGIN ?? dev('pds'),
}

// ---- D1 --------------------------------------------------------------------

type D1 = { uuid: string; name: string }
const findDb = () => json<D1[]>(wrangler(['d1', 'list', '--json'], { quiet: true })).find((d) => d.name === prefix)
let db = findDb()
if (!db) {
  console.log(`creating D1 database ${prefix}`)
  wrangler(['d1', 'create', prefix])
  db = findDb()
  if (!db) throw new Error('D1 database was not created')
}
wrangler(['d1', 'execute', prefix, '--remote', '--file', join(root, 'deploy', 'schema.sql'), '-y'], { quiet: true })

// ---- build and deploy ------------------------------------------------------

await build({ origins, names, db: { name: db.name, id: db.uuid }, accountId })
for (const site of SITES) {
  console.log(`deploying ${names[site]}`)
  process.stdout.write(wrangler(['deploy'], { cwd: join(OUT, site) }))
}

console.log(`
  atworkplace shell   ${origins.shell}
  demo app            ${origins.app}
  mock PDS (phase 2)  ${origins.pds}/login
`)

// In GitHub Actions, hand the origins to later steps (.github/workflows/deploy.yml).
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `origins=${JSON.stringify(origins)}\nshell=${origins.shell}\n`)
}
