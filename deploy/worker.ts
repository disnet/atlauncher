// Turns a Site into a Cloudflare Worker with static assets: every request
// goes to the site's handlers first (run_worker_first), then to the files
// in the Worker's assets directory.

import { dispatch, type Site } from '../lib/http.ts'
import type { Tables } from '../lib/store.ts'
import { d1Tables, type D1Database } from './d1.ts'

export interface Env {
  DB: D1Database
  ASSETS?: { fetch(req: Request): Promise<Response> }
}

async function asset(assets: NonNullable<Env['ASSETS']>, req: Request, url: URL): Promise<Response | undefined> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return
  // html_handling is "none", so /callback.html (the OAuth redirect_uri)
  // keeps its URL, and directories need their index.html named.
  const u = new URL(url)
  if (u.pathname.endsWith('/')) u.pathname += 'index.html'
  const res = await assets.fetch(new Request(u, req))
  return res.status === 404 ? undefined : res
}

export function worker(makeSite: (tables: Tables) => Site) {
  return {
    fetch(req: Request, env: Env) {
      const site = makeSite(d1Tables(env.DB))
      const assets = env.ASSETS
      return dispatch(site, req, assets ? (r, url) => asset(assets, r, url) : undefined)
    },
  }
}
