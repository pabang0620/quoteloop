import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Tiny document store on SQLite. Every service opens its own file; nothing is shared.
export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE IF NOT EXISTS docs (
    col TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (col, id)
  )`)
  const selOne = db.prepare('SELECT body FROM docs WHERE col = ? AND id = ?')
  const selAll = db.prepare('SELECT body FROM docs WHERE col = ? ORDER BY rowid')
  const upsert = db.prepare('INSERT INTO docs (col, id, body) VALUES (?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET body = excluded.body')
  const delOne = db.prepare('DELETE FROM docs WHERE col = ? AND id = ?')
  let depth = 0

  const store = {
    get: (col, id) => {
      const row = selOne.get(col, String(id))
      return row ? JSON.parse(row.body) : null
    },
    put: (col, id, doc) => {
      upsert.run(col, String(id), JSON.stringify(doc))
      return doc
    },
    patch: (col, id, fields) => {
      const current = store.get(col, id)
      if (!current) throw new Error(`${col}/${id} not found`)
      return store.put(col, id, { ...current, ...fields })
    },
    list: (col, filter) => {
      const all = selAll.all(col).map((r) => JSON.parse(r.body))
      return filter ? all.filter(filter) : all
    },
    del: (col, id) => delOne.run(col, String(id)),
    // Synchronous transaction: nothing else runs between the check and the write inside fn.
    tx: (fn) => {
      if (depth > 0) return fn()
      depth += 1
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      } finally {
        depth -= 1
      }
    },
    dump: () => db.prepare('SELECT col, id, body FROM docs').all(),
    close: () => db.close(),
  }
  return store
}
