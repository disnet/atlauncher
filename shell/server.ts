// Runs the shell (shell/site.ts) under Node for local development. Account
// lists are kept in .data/shell.json so they survive restarts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHELL_PORT } from '../lib/config.ts'
import { startServer } from '../lib/node.ts'
import { memoryTables } from '../lib/store.ts'
import { SHELL_TABLE, shellSite, type ShellAccount } from './site.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const DATA_FILE = join(root, '.data', 'shell.json')

export function start() {
  let saved: Record<string, ShellAccount[]> = {}
  try {
    saved = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
  } catch {}
  let loaded = false
  const tables = memoryTables((name, entries) => {
    if (name !== SHELL_TABLE || !loaded) return
    mkdirSync(dirname(DATA_FILE), { recursive: true })
    writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2))
  })
  const accounts = tables<ShellAccount[]>(SHELL_TABLE)
  for (const [sid, list] of Object.entries(saved)) void accounts.set(sid, list)
  loaded = true

  return startServer(shellSite(tables), SHELL_PORT, [
    ['/dist/', join(root, 'dist', 'shell')],
    ['/', join(here, 'public')],
  ])
}
