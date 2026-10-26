// Small key-value tables for server state: the shell's account lists, the
// app's popup relay, and the mock PDS's codes and tokens.
//
// Locally they live in memory. On Cloudflare Pages each request may run in a
// different isolate, so they live in D1 instead (deploy/d1.ts). `add` and
// `take` are atomic in both, which is what makes codes single-use and
// refresh tokens rotate.

export interface Table<T> {
  get(key: string): Promise<T | undefined>
  /** Insert or replace. */
  set(key: string, value: T, ttlMs?: number): Promise<void>
  /** Insert only if the key is absent (or expired). False if it was there. */
  add(key: string, value: T, ttlMs: number): Promise<boolean>
  /** Read and delete in one step. */
  take(key: string): Promise<T | undefined>
}

/** Opens the table with this name. */
export type Tables = <T>(name: string) => Table<T>

export function memoryTables(onSet?: (name: string, entries: Record<string, unknown>) => void): Tables {
  const all = new Map<string, Map<string, { value: unknown; expires: number }>>()
  return <T>(name: string): Table<T> => {
    let m = all.get(name)
    if (!m) all.set(name, (m = new Map()))
    const rows = m
    const live = (key: string) => {
      const row = rows.get(key)
      if (row && row.expires <= Date.now()) rows.delete(key)
      return rows.get(key)
    }
    const changed = () => {
      if (!onSet) return
      onSet(name, Object.fromEntries([...rows].filter(([k]) => live(k)).map(([k, v]) => [k, v.value])))
    }
    return {
      async get(key) {
        return live(key)?.value as T | undefined
      },
      async set(key, value, ttlMs) {
        rows.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : Infinity })
        changed()
      },
      async add(key, value, ttlMs) {
        if (live(key)) return false
        rows.set(key, { value, expires: Date.now() + ttlMs })
        return true
      },
      async take(key) {
        const row = live(key)
        rows.delete(key)
        return row?.value as T | undefined
      },
    }
  }
}
