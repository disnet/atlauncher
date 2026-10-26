// lib/store.ts tables on Cloudflare D1, for the deployed demo. Each request
// can land in a different isolate, so in-memory state would lose codes,
// tokens and relayed callbacks. D1 has one primary, so a write is visible to
// the next read, and `take` is a single DELETE ... RETURNING.

import type { Table, Tables } from '../lib/store.ts'

// The few D1 types used here, so the project needn't pull in workers-types.
export interface D1Database {
  prepare(sql: string): D1Statement
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number } }>
}

const NEVER = Number.MAX_SAFE_INTEGER
const expiry = (ttlMs?: number) => (ttlMs ? Date.now() + ttlMs : NEVER)

const UPSERT = `INSERT INTO kv (ns, key, value, expires) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, expires = excluded.expires`

export function d1Tables(db: D1Database): Tables {
  return <T>(ns: string): Table<T> => ({
    async get(key) {
      const row = await db
        .prepare('SELECT value FROM kv WHERE ns = ?1 AND key = ?2 AND expires > ?3')
        .bind(ns, key, Date.now())
        .first<{ value: string }>()
      return row ? (JSON.parse(row.value) as T) : undefined
    },
    async set(key, value, ttlMs) {
      await db.prepare(UPSERT).bind(ns, key, JSON.stringify(value), expiry(ttlMs)).run()
    },
    async add(key, value, ttlMs) {
      // Replaces a row only if it has expired, so a live key is never overwritten.
      const now = Date.now()
      const { meta } = await db
        .prepare(`${UPSERT} WHERE kv.expires <= ?5`)
        .bind(ns, key, JSON.stringify(value), now + ttlMs, now)
        .run()
      if (Math.random() < 0.05) await db.prepare('DELETE FROM kv WHERE expires <= ?1').bind(now).run()
      return meta.changes > 0
    },
    async take(key) {
      const row = await db
        .prepare('DELETE FROM kv WHERE ns = ?1 AND key = ?2 RETURNING value, expires')
        .bind(ns, key)
        .first<{ value: string; expires: number }>()
      return row && row.expires > Date.now() ? (JSON.parse(row.value) as T) : undefined
    },
  })
}
