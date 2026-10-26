// Minimal IndexedDB key/value store. CryptoKey objects (including
// non-extractable private keys) survive structured clone, so DPoP keys can be
// stored here without ever being exported.

const DB = 'atworkplace-demo'
const STORE = 'kv'

let dbp: Promise<IDBDatabase> | undefined
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const idbGet = <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key))
export const idbSet = (key: string, value: unknown) => tx('readwrite', (s) => s.put(value, key))
export const idbDel = (key: string) => tx('readwrite', (s) => s.delete(key))
