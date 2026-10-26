// Runs the shell (shell/site.ts) under Node for local development. Account
// lists and the prototype's workspaces are kept in .data/ so they survive
// restarts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHELL_PORT } from '../lib/config.ts'
import { startServer } from '../lib/node.ts'
import { memoryTables } from '../lib/store.ts'
import { SHELL_TABLE, WORKSPACE_TABLE, shellSite } from './site.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
/** Table name → the file that keeps it. */
const DATA_FILES: Record<string, string> = {
  [SHELL_TABLE]: join(root, '.data', 'shell.json'),
  [WORKSPACE_TABLE]: join(root, '.data', 'shell-workspace.json'),
}

export function start() {
  let loaded = false
  const tables = memoryTables((name, entries) => {
    const file = DATA_FILES[name]
    if (!file || !loaded) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(entries, null, 2))
  })
  for (const [name, file] of Object.entries(DATA_FILES)) {
    let saved: Record<string, unknown> = {}
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'))
    } catch {}
    const table = tables(name)
    for (const [sid, value] of Object.entries(saved)) void table.set(sid, value)
  }
  loaded = true

  return startServer(shellSite(tables), SHELL_PORT, [
    ['/dist/', join(root, 'dist', 'shell')],
    ['/', join(here, 'public')],
  ])
}
