// Builds the Workers into deploy/out/<site>/: the server bundle
// (worker.js), the static files (public/), and a wrangler.json naming the
// D1 database. The deployed origins are baked into both bundles.

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { MOCK_APPS, type MockApp } from '../lib/config.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OUT = join(root, 'deploy', 'out')

export type SiteName = 'shell' | 'app' | 'pds' | MockApp
export const SITES: SiteName[] = ['shell', 'app', 'pds', ...MOCK_APPS]

export type Origins = Record<SiteName, string>

export interface BuildConfig {
  origins: Origins
  names: Record<SiteName, string>
  db: { name: string; id: string }
  accountId?: string
}

/** Which source directory holds each site's static files. */
const PUBLIC: Partial<Record<SiteName, string>> = {
  shell: 'shell/public',
  app: 'app/public',
  ...Object.fromEntries(MOCK_APPS.map((m) => [m, 'mocks/public'])),
}

export async function build(cfg: BuildConfig) {
  rmSync(OUT, { recursive: true, force: true })
  const define = { __ATWORKPLACE_ORIGINS__: JSON.stringify(cfg.origins) }

  // Browser code, as scripts/build.ts builds it, into each site's public/dist.
  await esbuild.build({
    entryPoints: {
      'shell/public/dist/main': 'shell/src/main.ts',
      'app/public/dist/main': 'app/src/main.ts',
      'app/public/dist/callback': 'app/src/callback.ts',
      // One bundle serves every mock app; each Worker gets its own copy.
      ...Object.fromEntries(MOCK_APPS.map((m) => [`${m}/public/dist/main`, 'mocks/src/main.ts'])),
    },
    outdir: OUT,
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: true,
    define,
    logLevel: 'warning',
  })

  // Server code, one Worker per site.
  await esbuild.build({
    entryPoints: Object.fromEntries(SITES.map((s) => [`${s}/worker`, `deploy/workers/${s}.ts`])),
    outdir: OUT,
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    define,
    logLevel: 'warning',
  })

  for (const site of SITES) {
    const dir = join(OUT, site)
    mkdirSync(dir, { recursive: true })
    const pub = PUBLIC[site]
    if (pub) cpSync(join(root, pub), join(dir, 'public'), { recursive: true })
    const config = {
      name: cfg.names[site],
      main: 'worker.js',
      compatibility_date: '2025-09-01',
      workers_dev: true,
      ...(cfg.accountId ? { account_id: cfg.accountId } : {}),
      ...(pub
        ? {
            assets: {
              directory: 'public',
              binding: 'ASSETS',
              // The site's handlers set CSP headers on its pages, so they run first.
              run_worker_first: true,
              html_handling: 'none',
              not_found_handling: 'none',
            },
          }
        : {}),
      d1_databases: [{ binding: 'DB', database_name: cfg.db.name, database_id: cfg.db.id }],
    }
    writeFileSync(join(dir, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n')
  }
  console.log(`built ${SITES.join(', ')} into ${OUT}`)
}
